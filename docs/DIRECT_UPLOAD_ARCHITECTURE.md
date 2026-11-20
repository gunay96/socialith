# Direct-to-R2 upload architecture (design, owner decision of Phase 5A acceptance)

**Status: designed, NOT implemented.** TD-60 stays **open** until this is built *and* verified against the real Cloudflare R2 bucket (TD-61). Nothing in this file has been tested against R2; every statement about R2's behaviour is listed in §9 as something to verify.

## 1. Decision

The production upload path for large media packs must be a **direct-to-R2 multipart upload**, created and controlled by the backend:

* the backend creates an **upload session** and the multipart upload (it holds the R2 credentials);
* the browser receives only **short-lived presigned URLs**, one per part;
* progress is **chunk by chunk** and real (bytes the browser sent, confirmed against what R2 says it stored);
* completion is **verified on the server** (part list, size, checksum, signature/type) before anything is processed;
* expired or abandoned uploads are **cleaned up**;
* processing after a successful upload runs in the **existing background worker** (BullMQ, `operation_tasks`).

The single-request upload (`POST /api/media/uploads`) stays for development and small files. It is not the production solution for large packs (TD-60: proxy body cap near 100 MB, `requestTimeout` 300 s).

R2 credentials never reach the browser. A presigned URL grants one `PUT` of one part of one server-chosen object key, for a few minutes, and nothing else.

## 2. Flow

```
Browser                       API (credentials)                    R2                      Worker
  | POST /upload-sessions         |                                  |                        |
  |  name, size, type, [sha256]   |-- validate type/size/quota        |                        |
  |                               |-- CreateMultipartUpload --------> |                        |
  |<-- sessionId, partSize, parts-|                                  |                        |
  | POST /sessions/:id/parts      |                                  |                        |
  |  partNumbers, part SHA-256s   |-- presign UploadPart (signed      |                        |
  |<-- URLs (expire in minutes) --|   checksum header, 1 key, 1 part) |                        |
  | PUT part bytes ---------------------------------------------->  | (stores part)          |
  |   (4 parts in parallel, retry a part on failure)                 |                        |
  | GET /sessions/:id  (resume / progress, truth from ListParts) --> |                        |
  | POST /sessions/:id/complete   |-- ListParts: count and sizes ---> |                        |
  |   part numbers + ETags        |-- CompleteMultipartUpload ------> |                        |
  |                               |-- HEAD: size == declared          |                        |
  |                               |-- task VERIFY + enqueue ----------------------------------> |
  |                               |                                  | <- ranged GET, SHA-256 --|
  |                               |                                  |    signature / MIME      |
  |                               |                                  |    duplicate check       |
  |                               |                                  |    ZIP: existing extract |
```

## 3. Data model (additive; to be built)

`media_upload_sessions`: id, organization_id, created_by_id, file_name, declared_bytes, declared_content_type, declared_sha256 (nullable, informational), kind (ZIP | FILE), pack_name / pack_id (what to create), storage_key (server-generated final key, see §6), r2_upload_id, part_size, part_count, status (`CREATED`, `UPLOADING`, `COMPLETING`, `VERIFYING`, `ACCEPTED`, `FAILED`, `ABORTED`, `EXPIRED`), error_code / error_message / error_remedy, task_id (the verification task), created_at, last_activity_at, expires_at, completed_at.
`media_upload_session_parts` (optional cache; **R2's ListParts is the truth**): session_id, part_number, size, etag, checksum_sha256, confirmed_at.

## 4. API (all authenticated; EDITOR; organization-scoped; every call audited)

| Call | Does |
|---|---|
| `POST /api/media/upload-sessions` | Validates the extension allow-list and the size against `MEDIA_MAX_FILE_BYTES` / `MEDIA_MAX_ARCHIVE_BYTES`, the number of open sessions per organization, and total bytes in flight. Creates the session and the multipart upload. Returns session id, part size, part count, expiry. |
| `POST /api/media/upload-sessions/:id/parts` | For the requested part numbers (each within `1..part_count`), returns presigned `PUT` URLs. The client sends each part's SHA-256 (computed in the browser with `SubtleCrypto`, one part at a time); the URL signs it as a required header. |
| `GET /api/media/upload-sessions/:id` | Status, which parts R2 holds (ListParts), confirmed bytes. Used for progress after a refresh and for resuming. |
| `POST /api/media/upload-sessions/:id/complete` | Compares the client's part list with ListParts (same numbers, sizes, ETags), completes the multipart upload, checks the object size equals the declared size, creates the verification task and enqueues it. Idempotent. |
| `POST /api/media/upload-sessions/:id/abort` | Aborts the multipart upload and the session. |

## 5. Verification after upload (worker, `VERIFY_UPLOAD`)

Order, cheapest first, all on the stored object and none trusting the client:

1. **Size** equals the declared size (already checked at completion; checked again).
2. **Signature / type**: ranged GET of the first 4 KiB, then the same `validateUpload` the single-request path uses (extension, magic bytes, MIME cross-check). A file that is not what it claims is deleted and the session FAILED with the usual plain-language reason.
3. **Whole-object SHA-256**, streamed from R2. This is the authority: it is what duplicate detection uses. If the client declared a SHA-256 and it differs, the upload is FAILED as corrupted in transit.
4. **Duplicates**, exactly as today (same archive twice → the earlier pack; same file → DUPLICATE row, nothing stored twice; the object is deleted).
5. **ZIP**: continues into the existing `EXTRACT_ZIP` flow (`scanZip` then `extractZip`); the archive is already at its final key, so there is no copy.

Progress of step 3 is real (bytes hashed of bytes total) through the same `TaskReporter` and ledger as every other task.

## 6. Keys

The object key is generated by the server from ids only (`libraryKeys`-style: `{organizationId}/uploads/{sessionId}/source`) and for a ZIP is the same key the pack's archive uses today, so nothing is copied after verification. No file name, no client-supplied string, ever becomes part of a key. Verified originals are never overwritten (`putFile`'s no-overwrite rule applies to the final copy path; multipart creates a fresh key per session).

## 7. Cleanup of expired and abandoned uploads

* A repeatable job in the worker (every 15 minutes; deterministic job id so two workers never double-run it) takes sessions in `CREATED` / `UPLOADING` / `COMPLETING` whose `expires_at` passed (default 24 h after the last activity, `MEDIA_UPLOAD_SESSION_TTL_HOURS`), calls `AbortMultipartUpload`, and marks them `EXPIRED`. Sessions stuck in `VERIFYING` past a timeout are failed with a remedy.
* A failed or rejected verification deletes the object.
* Session rows are kept 30 days for the audit trail, then deleted.
* **Backstop in R2 itself**: a lifecycle rule that aborts incomplete multipart uploads after a few days (configured by the owner; §9), so an API outage never leaves paid-for orphan parts behind.

## 8. Security

* Presigned URLs: one object key, one part number, `PUT` only, expiry of a few minutes, the part's SHA-256 signed in. They are never logged (query strings are redacted) and never stored.
* Sessions are bound to the creating user and organization; another organization's session id answers 404.
* Limits: sessions per organization open at once, bytes in flight, part size and part count validated at signing time, rate limits on the session and signing endpoints. The server decides the part size; the client cannot ask for a different one.
* Bucket: private, no public access, no public URL ever generated for the library (as today). **CORS** allows only the web app's origin, only `PUT` (and `GET`/`HEAD` if the browser needs them), and exposes the `ETag` header.
* Audit: `MEDIA_UPLOAD_SESSION_CREATED / COMPLETED / ABORTED / EXPIRED / FAILED`.
* The API still never accepts a file body for large uploads, so request-size abuse of the API process disappears for them.

## 9. To verify against the REAL bucket before TD-60 and TD-61 can close

Nothing below has been exercised; each is an assumption from documentation until tested with the owner's bucket:

1. Multipart create / presigned part `PUT` from a browser origin / complete / abort, end to end, including the CORS preflight and the `ETag` header being readable.
2. That R2 enforces a signed `x-amz-checksum-sha256` on `UploadPart` (rejecting a mismatching part), and how `CompleteMultipartUpload` treats checksums. If it does not enforce them, the per-part checksum becomes advisory and the worker's whole-object SHA-256 remains the only integrity proof (the design already treats it as the authority).
3. Minimum and maximum part size, maximum part count, and the object-size ceiling that result (with a 16 MiB part, 10,000 parts allow about 156 GiB).
4. `ListParts`, `HEAD` and ranged `GET` behaviour and consistency right after completion.
5. The lifecycle rule for aborting incomplete multipart uploads, and what it costs to leave open.
6. Operation counts and cost of a large pack (each part is a Class A operation).
7. Uploads go to the R2 endpoint, not through the Cloudflare tunnel or proxy (so the ~100 MB body cap does not apply).
8. The existing S3 adapter's multipart path (`R2AssetStorage` already uses multipart for server-side uploads) against the real bucket.

CI cannot prove any of this. The adapter can be exercised against MinIO in CI for the flow itself (create, part, complete, abort, expiry cleanup); the owner's bucket is the only proof of R2's own behaviour.

## 10. Build order (a later, separate sub-phase; needs the owner's R2 bucket for its final check)

1. Migration for the two tables; `UploadSessionService` with the state machine and all validation (unit and MySQL integration tests with a fake S3 that implements multipart).
2. API routes, signing, limits, audit.
3. Worker `VERIFY_UPLOAD` and the cleanup job (real FFmpeg/ZIP tests unchanged; new tests for verification failures and expiry).
4. Browser uploader: part slicing, per-part checksum, 4 parallel parts, retry with backoff, URL refresh, resume after refresh, real progress per part (the Upload page already shows real bytes).
5. MinIO job in CI.
6. Real-R2 verification (§9) with the owner, recorded in the checkpoint.

## 11. Storage implications

None beyond the media itself: parts are assembled into the final object, and nothing is kept twice. (The retained original ZIP archives are a separate decision; see `MEDIA_PACK_ARCHITECTURE.md` §12.)
