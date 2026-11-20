# Media Library to Publishing Center hand-off (decision record, Phase 5F)

Status: **decided by the owner on 2026-11-20; not built; the compatibility gate below is OPEN.** Nothing in this document has been verified against real Cloudflare R2 or the live Upload-Post service. It belongs to Phase 5F, not 5D.

## 1. Decision

Private Cloudflare R2 storage with **temporary, file-specific, read-only signed URLs**.

* The bucket is never made public, and rendered files are not copied to a permanently public bucket.
* A signed URL is generated **immediately before the publishing hand-off**, initially valid for **6 hours**.
* A signed URL is **never stored** in a database field and **never written to a log** (log the asset id and the expiry only).
* It is **regenerated for every retry**.
* The response must carry the correct `Content-Type` and `Content-Length`, be a direct file response (**no redirects**), and support `HEAD`, `GET` and HTTP range requests where R2 supports them.
* The Media Library asset itself stays private; only the signed URL is shared, and only for its lifetime.

## 2. Compatibility gate (must pass before any claim of completion)

Upload-Post must be shown, from an external environment with no authenticated Socialith access, to:

1. accept an R2 **presigned** URL as the `video` (or `photos[]`) parameter;
2. fetch the **complete** file (compare size and SHA-256 of what the platform ends up with where observable);
3. finish its asynchronous processing **before the URL expires** (for an immediate post, and for a scheduled post, where the fetch time matters most).

If Upload-Post rejects presigned URLs, **stop and report the exact incompatibility**. Do not make the bucket public and do not introduce permanent public URLs.

A successful R2 URL generation test alone proves nothing about this gate.

### What the public documentation says (read 2026-11-20; documentation only, not a test)

* `video`: "can be a file upload or a video URL". `photos[]`: files "or public HTTPS URLs".
* Stated about the URL: only "public HTTPS" for photos. **Not stated:** whether query strings or signed URLs are accepted, whether redirects are followed, any fetch time limit or retry, content-type requirements.
* "When video is a URL, we fetch the file in the background too" (asynchronous upload, with a `request_id` to poll). TikTok "downloads the media first and publishes afterwards".
* For a **scheduled** post the documentation says the media "is never uploaded again" and refers to "Signed URLs of the stored video"; **when** the URL is fetched (at scheduling time or at run time) is **not stated**. This is the open question already recorded in `UPLOAD_POST_API_MAPPING.md` (item 4), and until it is answered a 6-hour URL is only safe for a post that is fetched at request time or immediately after scheduling.
* Multipart upload of the video bytes is supported (`-F video=@file.mp4`). That would avoid the URL-expiry question entirely, but it is a different design (Socialith streams the file to Upload-Post) and **has not been chosen**; it is recorded here only as the documented alternative if the gate fails.

## 3. How the gate is to be run (needs the owner)

Needs two things this development machine does not have and that must not be pasted into chat: a **real R2 bucket** (a throwaway one) with credentials in the local environment, and the Upload-Post **test profile** key already used for the read-only checks.

1. Upload a small and a large (hundreds of MB) test video to the private bucket.
2. Generate a 6-hour presigned `GET` URL; confirm from a machine with no Socialith session that `curl -I` and a ranged `curl` return the right headers and bytes, with no redirect.
3. Hand the URL to Upload-Post for an **immediate** post to the test profile with `async_upload` on; poll the status; record when the fetch happened relative to expiry.
4. Repeat with a **scheduled** post a few hours out; record whether the file is fetched at scheduling time or at the scheduled time (by shortening the URL's expiry on a second run to make that observable).
5. Record the result, with dates, in this file. Only then may the hand-off be called compatible.

No real publishing to a connected account happens in this procedure without the owner's explicit approval.

## 4. Not in Phase 5D

The roadmap places the Publishing Center integration with provenance in 5F. Phase 5D does not build any part of this bridge.
