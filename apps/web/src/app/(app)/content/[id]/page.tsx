"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import {
  apiGet,
  apiPost,
  apiPatch,
  apiDelete,
  apiUpload,
  buildQueryString,
  ApiError,
  hasActiveJob,
  isPublishingInFlight,
  PLATFORMS,
  type AssignTargetsResult,
  type AssetType,
  type Content,
  type ContentDetail,
  type ContentGenerationJob,
  type ContentVariation,
  type JobStatus,
  type ListContentTargetsResult,
  type ListSocialAccountsResult,
  type ListSoundsResult,
  type MetricsRollup,
  type Platform,
  type PostMetricsSnapshot,
  type PublishAttempt,
  type SocialAccount,
  type Sound,
  type VideoRenderJob,
} from "@/lib/api";
import { useCurrentUser } from "@/lib/auth-context";

/** Polls a job-list endpoint every 2s while any job is still in flight — no fabricated progress, just the real discrete status. */
function useJobPolling<T extends { status: JobStatus }>(fetchJobs: () => Promise<T[]>, onSettled: () => void) {
  const [jobs, setJobs] = useState<T[]>([]);
  const onSettledRef = useRef(onSettled);
  onSettledRef.current = onSettled;

  async function refresh() {
    const next = await fetchJobs();
    setJobs((prev) => {
      const prevActive = hasActiveJob(prev);
      const nextActive = hasActiveJob(next);
      if (prevActive && !nextActive) onSettledRef.current();
      return next;
    });
  }

  useEffect(() => {
    refresh();
    const interval = setInterval(() => {
      setJobs((current) => {
        if (hasActiveJob(current)) refresh();
        return current;
      });
    }, 2000);
    return () => clearInterval(interval);
  }, []);

  return { jobs, refresh };
}

export default function ContentDetailPage({ params }: { params: { id: string } }) {
  const me = useCurrentUser();
  const canEdit = me.role !== "VIEWER";
  const contentId = params.id;

  const [content, setContent] = useState<ContentDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  function loadContent() {
    apiGet<ContentDetail>(`/api/content/${contentId}`)
      .then(setContent)
      .catch((err) => setError(err instanceof ApiError ? err.message : "Something went wrong."));
  }

  useEffect(loadContent, [contentId]);

  if (error) return <p className="text-sm text-red-400">{error}</p>;
  if (!content) return <p className="text-sm text-muted">Loading…</p>;

  return (
    <div className="max-w-3xl">
      <Link href="/content" className="mb-4 inline-block text-sm text-muted hover:text-foreground">
        ← All content
      </Link>

      <ContentHeader content={content} canEdit={canEdit} onUpdated={setContent} />
      <SoundSection content={content} canEdit={canEdit} onUpdated={loadContent} />
      <ContentMetricsSection contentId={contentId} />
      <GenerationSection contentId={contentId} canEdit={canEdit} onSucceeded={loadContent} />
      <VariationsSection contentId={contentId} variations={content.variations} canEdit={canEdit} onSaved={loadContent} />
      <AssetsSection contentId={contentId} assets={content.assets} canEdit={canEdit} onSaved={loadContent} />
      <RenderSection contentId={contentId} assets={content.assets} canEdit={canEdit} onSucceeded={loadContent} />
      <TargetsSection content={content} canEdit={canEdit} onChanged={loadContent} />
    </div>
  );
}

function ContentHeader({
  content,
  canEdit,
  onUpdated,
}: {
  content: ContentDetail;
  canEdit: boolean;
  onUpdated: (c: ContentDetail) => void;
}) {
  const [caption, setCaption] = useState(content.caption ?? "");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  async function handleSave() {
    setSaveError(null);
    setSaving(true);
    try {
      const updated = await apiPatch<Content>(`/api/content/${content.id}`, { caption: caption || null });
      onUpdated({ ...content, ...updated });
    } catch (err) {
      setSaveError(err instanceof ApiError ? err.message : "Something went wrong.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mb-6 rounded border border-border bg-surface p-6">
      <div className="mb-2 flex items-center gap-3">
        <span className="text-sm text-muted">Status</span>
        <span>{content.status}</span>
        <span className="text-sm text-muted">— {content._count.targets} target account(s)</span>
      </div>
      {canEdit ? (
        <>
          <textarea
            value={caption}
            onChange={(e) => setCaption(e.target.value)}
            rows={2}
            className="w-full rounded border border-border bg-background px-3 py-2 text-foreground outline-none focus:border-foreground"
          />
          <button
            onClick={handleSave}
            disabled={saving}
            className="mt-2 rounded border border-border px-3 py-1.5 text-sm disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save caption"}
          </button>
          {saveError && <p className="mt-2 text-sm text-red-400">{saveError}</p>}
        </>
      ) : (
        <p>{content.caption ?? <span className="text-muted">(no caption)</span>}</p>
      )}
    </div>
  );
}

function SoundSection({
  content,
  canEdit,
  onUpdated,
}: {
  content: ContentDetail;
  canEdit: boolean;
  onUpdated: () => void;
}) {
  const [sounds, setSounds] = useState<Sound[] | null>(null);
  const [selected, setSelected] = useState(content.soundId ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Up to 1000 in one request — same reasoning as the target-account
    // picker below: a bulk selector, not one request per option.
    apiGet<ListSoundsResult>(`/api/sounds${buildQueryString({ pageSize: 1000, status: "ACTIVE" })}`).then((res) =>
      setSounds(res.items),
    );
  }, []);

  useEffect(() => {
    setSelected(content.soundId ?? "");
  }, [content.soundId]);

  async function handleChange(nextSoundId: string) {
    setSelected(nextSoundId);
    setError(null);
    setSaving(true);
    try {
      await apiPatch(`/api/content/${content.id}`, { soundId: nextSoundId || null });
      onUpdated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="mb-6 rounded border border-border bg-surface p-4">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-medium text-muted">Sound / Music (music-seeding)</h2>
        <Link href="/sounds" className="text-xs text-muted hover:text-foreground hover:underline">
          Manage sound library
        </Link>
      </div>
      {canEdit ? (
        <select
          value={selected}
          disabled={saving || !sounds}
          onChange={(e) => handleChange(e.target.value)}
          className="w-full rounded border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-foreground disabled:opacity-60"
        >
          <option value="">No sound selected</option>
          {sounds?.map((s) => (
            <option key={s.id} value={s.id}>
              {s.title}
              {s.artist ? ` — ${s.artist}` : ""} ({s.platform})
            </option>
          ))}
        </select>
      ) : content.sound ? (
        <Link href={`/sounds/${content.sound.id}`} className="text-sm hover:underline">
          {content.sound.title}
          {content.sound.artist ? ` — ${content.sound.artist}` : ""}
        </Link>
      ) : (
        <p className="text-sm text-muted">No sound selected.</p>
      )}
      {error && <p className="mt-2 text-sm text-red-400">{error}</p>}
      <p className="mt-2 text-xs text-muted">
        TikTok&rsquo;s official Content Posting API has no way to attach an existing sound to a video
        programmatically — selecting a sound here tracks it for campaign/analytics purposes, but publishing still
        uploads the video with its own embedded audio. See the target row&rsquo;s attempt detail after publishing for
        the exact capability note recorded for each attempt.
      </p>
    </section>
  );
}

function ContentMetricsSection({ contentId }: { contentId: string }) {
  const [metrics, setMetrics] = useState<MetricsRollup | null>(null);

  useEffect(() => {
    apiGet<MetricsRollup>(`/api/analytics/content/${contentId}`).then(setMetrics);
  }, [contentId]);

  if (!metrics || metrics.publishedCount === 0) return null;

  return (
    <section className="mb-6">
      <h2 className="mb-3 text-sm font-medium text-muted">Performance (published posts only)</h2>
      <div className="grid grid-cols-4 gap-3">
        {(
          [
            ["Views", metrics.viewCount],
            ["Likes", metrics.likeCount],
            ["Comments", metrics.commentCount],
            ["Shares", metrics.shareCount],
          ] as const
        ).map(([label, value]) => (
          <div key={label} className="rounded border border-border bg-surface p-4">
            <div className="text-2xl font-semibold tracking-tight">{value.toLocaleString()}</div>
            <div className="text-xs text-muted">{label}</div>
          </div>
        ))}
      </div>
      {metrics.syncedCount < metrics.publishedCount && (
        <p className="mt-2 text-xs text-muted">
          {metrics.publishedCount - metrics.syncedCount} published target(s) haven&rsquo;t been synced yet — use
          &ldquo;Sync analytics&rdquo; below on each one.
        </p>
      )}
    </section>
  );
}

function VariationsSection({
  contentId,
  variations,
  canEdit,
  onSaved,
}: {
  contentId: string;
  variations: ContentVariation[];
  canEdit: boolean;
  onSaved: () => void;
}) {
  return (
    <section className="mb-6">
      <h2 className="mb-3 text-sm font-medium text-muted">Platform variations</h2>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {PLATFORMS.map((platform) => (
          <VariationCard
            key={platform}
            contentId={contentId}
            platform={platform}
            existing={variations.find((v) => v.platform === platform) ?? null}
            canEdit={canEdit}
            onSaved={onSaved}
          />
        ))}
      </div>
    </section>
  );
}

function VariationCard({
  contentId,
  platform,
  existing,
  canEdit,
  onSaved,
}: {
  contentId: string;
  platform: Platform;
  existing: ContentVariation | null;
  canEdit: boolean;
  onSaved: () => void;
}) {
  const [title, setTitle] = useState(existing?.title ?? "");
  const [caption, setCaption] = useState(existing?.caption ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave() {
    setError(null);
    setSaving(true);
    try {
      await apiPatch<ContentVariation>(`/api/content/${contentId}/variations/${platform}`, {
        title: platform === "YOUTUBE" ? title || null : undefined,
        caption: caption || null,
      });
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded border border-border bg-surface p-4">
      <div className="mb-2 text-sm font-medium">{platform}</div>
      {platform === "YOUTUBE" && (
        <input
          type="text"
          placeholder="Title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          disabled={!canEdit}
          className="mb-2 w-full rounded border border-border bg-background px-2 py-1 text-sm text-foreground outline-none focus:border-foreground disabled:opacity-60"
        />
      )}
      <textarea
        placeholder="Caption"
        value={caption}
        onChange={(e) => setCaption(e.target.value)}
        disabled={!canEdit}
        rows={3}
        className="w-full rounded border border-border bg-background px-2 py-1 text-sm text-foreground outline-none focus:border-foreground disabled:opacity-60"
      />
      {canEdit && (
        <button
          onClick={handleSave}
          disabled={saving}
          className="mt-2 rounded border border-border px-2 py-1 text-xs disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save"}
        </button>
      )}
      {error && <p className="mt-1 text-xs text-red-400">{error}</p>}
    </div>
  );
}

function AssetsSection({
  contentId,
  assets,
  canEdit,
  onSaved,
}: {
  contentId: string;
  assets: ContentDetail["assets"];
  canEdit: boolean;
  onSaved: () => void;
}) {
  const [type, setType] = useState<AssetType>("VIDEO");
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const [file, setFile] = useState<File | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  async function handleAdd(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setAdding(true);
    try {
      await apiPost(`/api/content/${contentId}/assets`, { type, url });
      setUrl("");
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong.");
    } finally {
      setAdding(false);
    }
  }

  async function handleUpload(e: FormEvent) {
    e.preventDefault();
    if (!file) return;
    setUploadError(null);
    setUploading(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      await apiUpload(`/api/content/${contentId}/assets/upload`, formData);
      setFile(null);
      onSaved();
    } catch (err) {
      setUploadError(err instanceof ApiError ? err.message : "Something went wrong.");
    } finally {
      setUploading(false);
    }
  }

  return (
    <section className="mb-6">
      <h2 className="mb-3 text-sm font-medium text-muted">Assets</h2>
      <ul className="mb-3 flex flex-col gap-2 text-sm">
        {assets.length === 0 && <li className="text-muted">No assets yet.</li>}
        {assets.map((a) => (
          <li key={a.id} className="flex items-center gap-3 text-muted">
            {a.type === "THUMBNAIL" || a.type === "IMAGE" ? (
              <img src={a.url} alt="" className="h-12 w-12 rounded border border-border object-cover" />
            ) : null}
            <span>
              [{a.type}
              {a.platform ? ` / ${a.platform}` : ""}]{" "}
              <a href={a.url} target="_blank" rel="noreferrer" className="hover:text-foreground hover:underline">
                {a.url}
              </a>
            </span>
          </li>
        ))}
      </ul>
      {canEdit && (
        <>
          <form onSubmit={handleUpload} className="mb-3 flex flex-wrap items-end gap-2">
            <input
              type="file"
              required
              accept="video/mp4,video/quicktime,video/webm,image/png,image/jpeg,image/webp"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              className="text-sm text-foreground"
            />
            <button
              type="submit"
              disabled={uploading || !file}
              className="rounded bg-foreground px-3 py-1.5 text-sm font-medium text-background disabled:opacity-50"
            >
              {uploading ? "Uploading…" : "Upload file"}
            </button>
          </form>
          {uploadError && <p className="mb-3 text-sm text-red-400">{uploadError}</p>}

          <form onSubmit={handleAdd} className="flex flex-wrap items-end gap-2">
            <select
              value={type}
              onChange={(e) => setType(e.target.value as AssetType)}
              className="rounded border border-border bg-surface px-2 py-1.5 text-sm text-foreground outline-none focus:border-foreground"
            >
              {(["VIDEO", "IMAGE", "AUDIO", "THUMBNAIL"] as AssetType[]).map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
            <input
              type="url"
              required
              placeholder="https://… (reference an existing URL instead of uploading)"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              className="w-96 rounded border border-border bg-surface px-2 py-1.5 text-sm text-foreground outline-none focus:border-foreground"
            />
            <button type="submit" disabled={adding} className="rounded border border-border px-3 py-1.5 text-sm disabled:opacity-50">
              {adding ? "Adding…" : "Add by URL"}
            </button>
          </form>
        </>
      )}
      {error && <p className="mt-2 text-sm text-red-400">{error}</p>}
    </section>
  );
}

/** Shared by job statuses (Phase 07) and ContentTarget publishing statuses (Phase 08) — both are small discrete-state string unions with the same "green=done, red=failed, accent=in progress, muted=waiting" meaning. */
function JobStatusBadge({ status }: { status: string }) {
  const color =
    status === "SUCCEEDED" || status === "PUBLISHED"
      ? "text-green-400"
      : status === "FAILED"
        ? "text-red-400"
        : status === "PROCESSING" || status === "PUBLISHING"
          ? "text-accent"
          : "text-muted";
  return <span className={color}>{status}</span>;
}

function GenerationSection({
  contentId,
  canEdit,
  onSucceeded,
}: {
  contentId: string;
  canEdit: boolean;
  onSucceeded: () => void;
}) {
  const { jobs, refresh } = useJobPolling<ContentGenerationJob>(
    () => apiGet<ContentGenerationJob[]>(`/api/content/${contentId}/generation`),
    onSucceeded,
  );
  const [requesting, setRequesting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleGenerate(platform: Platform | null) {
    setError(null);
    setRequesting(platform ?? "BASE");
    try {
      await apiPost(`/api/content/${contentId}/generation`, { platform });
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong.");
    } finally {
      setRequesting(null);
    }
  }

  return (
    <section className="mb-6">
      <h2 className="mb-3 text-sm font-medium text-muted">AI caption generation</h2>
      {canEdit && (
        <div className="mb-3 flex flex-wrap gap-2">
          <button
            onClick={() => handleGenerate(null)}
            disabled={requesting !== null}
            className="rounded border border-border px-3 py-1.5 text-sm disabled:opacity-50"
          >
            {requesting === "BASE" ? "Requesting…" : "Generate base caption"}
          </button>
          {PLATFORMS.map((platform) => (
            <button
              key={platform}
              onClick={() => handleGenerate(platform)}
              disabled={requesting !== null}
              className="rounded border border-border px-3 py-1.5 text-sm disabled:opacity-50"
            >
              {requesting === platform ? "Requesting…" : `Generate ${platform} caption`}
            </button>
          ))}
        </div>
      )}
      {error && <p className="mb-2 text-sm text-red-400">{error}</p>}
      {jobs.length === 0 ? (
        <p className="text-sm text-muted">No generation jobs yet.</p>
      ) : (
        <ul className="flex flex-col gap-1 text-sm">
          {jobs.map((job) => (
            <li key={job.id} className="text-muted">
              {job.platform ?? "base"} — <JobStatusBadge status={job.status} />
              {job.errorMessage ? <span className="text-red-400"> — {job.errorMessage}</span> : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function RenderSection({
  contentId,
  assets,
  canEdit,
  onSucceeded,
}: {
  contentId: string;
  assets: ContentDetail["assets"];
  canEdit: boolean;
  onSucceeded: () => void;
}) {
  const { jobs, refresh } = useJobPolling<VideoRenderJob>(
    () => apiGet<VideoRenderJob[]>(`/api/content/${contentId}/render`),
    onSucceeded,
  );
  const renderableAssets = assets.filter((a) => a.type === "VIDEO" || a.type === "IMAGE");
  const [sourceAssetId, setSourceAssetId] = useState<string>(renderableAssets[0]?.id ?? "");
  const [requesting, setRequesting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const firstRenderableAssetId = renderableAssets[0]?.id;
  useEffect(() => {
    if (!sourceAssetId && firstRenderableAssetId) setSourceAssetId(firstRenderableAssetId);
  }, [firstRenderableAssetId, sourceAssetId]);

  async function handleRender() {
    if (!sourceAssetId) return;
    setError(null);
    setRequesting(true);
    try {
      await apiPost(`/api/content/${contentId}/render`, { sourceAssetId, operation: "THUMBNAIL" });
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong.");
    } finally {
      setRequesting(false);
    }
  }

  return (
    <section className="mb-6">
      <h2 className="mb-3 text-sm font-medium text-muted">Video render (FFmpeg)</h2>
      {canEdit && (
        <div className="mb-3 flex flex-wrap items-end gap-2">
          {renderableAssets.length === 0 ? (
            <p className="text-sm text-muted">Upload a video or image asset above before rendering.</p>
          ) : (
            <>
              <select
                value={sourceAssetId}
                onChange={(e) => setSourceAssetId(e.target.value)}
                className="rounded border border-border bg-surface px-2 py-1.5 text-sm text-foreground outline-none focus:border-foreground"
              >
                {renderableAssets.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.type} — {a.url.split("/").pop()}
                  </option>
                ))}
              </select>
              <button
                onClick={handleRender}
                disabled={requesting}
                className="rounded border border-border px-3 py-1.5 text-sm disabled:opacity-50"
              >
                {requesting ? "Requesting…" : "Extract thumbnail"}
              </button>
            </>
          )}
        </div>
      )}
      {error && <p className="mb-2 text-sm text-red-400">{error}</p>}
      {jobs.length === 0 ? (
        <p className="text-sm text-muted">No render jobs yet.</p>
      ) : (
        <ul className="flex flex-col gap-1 text-sm">
          {jobs.map((job) => (
            <li key={job.id} className="text-muted">
              {job.operation} — <JobStatusBadge status={job.status} />
              {job.errorMessage ? <span className="text-red-400"> — {job.errorMessage}</span> : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function TargetsSection({
  content,
  canEdit,
  onChanged,
}: {
  content: ContentDetail;
  canEdit: boolean;
  onChanged: () => void;
}) {
  const contentId = content.id;
  const [targets, setTargets] = useState<ListContentTargetsResult | null>(null);
  const [showAssign, setShowAssign] = useState(false);
  const [accounts, setAccounts] = useState<ListSocialAccountsResult | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [assignResult, setAssignResult] = useState<AssignTargetsResult | null>(null);
  const [assignError, setAssignError] = useState<string | null>(null);
  const [assigning, setAssigning] = useState(false);

  const [scheduledAt, setScheduledAt] = useState("");
  const [scheduling, setScheduling] = useState(false);
  const [scheduleError, setScheduleError] = useState<string | null>(null);
  const [publishingNow, setPublishingNow] = useState(false);
  const [publishNowError, setPublishNowError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState<string | null>(null);

  function loadTargets() {
    apiGet<ListContentTargetsResult>(`/api/content/${contentId}/targets${buildQueryString({ pageSize: 50 })}`).then(
      (result) => {
        setTargets((prev) => {
          const prevInFlight = prev?.items.some((t) => isPublishingInFlight(t.status)) ?? false;
          const nextInFlight = result.items.some((t) => isPublishingInFlight(t.status));
          if (prevInFlight && !nextInFlight) onChanged(); // refresh Content.status once every target has settled
          return result;
        });
      },
    );
  }
  useEffect(loadTargets, [contentId]);

  // Real polling, not a fabricated progress bar — while any target is
  // SCHEDULED/PUBLISHING, re-fetch its actual current status every 2s.
  useEffect(() => {
    const interval = setInterval(() => {
      setTargets((current) => {
        if (current?.items.some((t) => isPublishingInFlight(t.status))) loadTargets();
        return current;
      });
    }, 2000);
    return () => clearInterval(interval);
  }, [contentId]);

  function loadAccountsToAssign() {
    // Up to 1000 in one request — a bulk selector, never one
    // request/checkbox per account (see lib/api.ts's ListSocialAccountsResult
    // and apps/api's own 1000-id cap on the assign endpoint).
    apiGet<ListSocialAccountsResult>(`/api/accounts${buildQueryString({ pageSize: 1000 })}`).then(setAccounts);
  }

  function toggleShowAssign() {
    setShowAssign((v) => !v);
    if (!showAssign && !accounts) loadAccountsToAssign();
  }

  function toggleSelected(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleAssign() {
    setAssignError(null);
    setAssigning(true);
    try {
      const result = await apiPost<AssignTargetsResult>(`/api/content/${contentId}/targets`, {
        socialAccountIds: Array.from(selected),
      });
      setAssignResult(result);
      setSelected(new Set());
      loadTargets();
      onChanged();
    } catch (err) {
      setAssignError(err instanceof ApiError ? err.message : "Something went wrong.");
    } finally {
      setAssigning(false);
    }
  }

  async function handleRemove(socialAccountId: string) {
    await apiDelete(`/api/content/${contentId}/targets`, { socialAccountIds: [socialAccountId] });
    loadTargets();
    onChanged();
  }

  async function handleSchedule(e: FormEvent) {
    e.preventDefault();
    setScheduleError(null);
    setScheduling(true);
    try {
      await apiPost(`/api/content/${contentId}/schedule`, { scheduledAt: new Date(scheduledAt).toISOString() });
      loadTargets();
      onChanged();
    } catch (err) {
      setScheduleError(err instanceof ApiError ? err.message : "Something went wrong.");
    } finally {
      setScheduling(false);
    }
  }

  async function handlePublishNow() {
    setPublishNowError(null);
    setPublishingNow(true);
    try {
      await apiPost(`/api/content/${contentId}/publish-now`);
      loadTargets();
      onChanged();
    } catch (err) {
      setPublishNowError(err instanceof ApiError ? err.message : "Something went wrong.");
    } finally {
      setPublishingNow(false);
    }
  }

  async function handleRetry(socialAccountId: string) {
    setRetrying(socialAccountId);
    try {
      await apiPost(`/api/content/${contentId}/targets/${socialAccountId}/retry`);
      loadTargets();
    } catch (err) {
      setPublishNowError(err instanceof ApiError ? err.message : "Something went wrong.");
    } finally {
      setRetrying(null);
    }
  }

  return (
    <section className="mb-6">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-medium text-muted">Target accounts ({content._count.targets})</h2>
        {canEdit && (
          <button onClick={toggleShowAssign} className="rounded border border-border px-3 py-1.5 text-sm">
            {showAssign ? "Close" : "Assign accounts"}
          </button>
        )}
      </div>

      {showAssign && accounts && (
        <div className="mb-4 rounded border border-border bg-surface p-4">
          <div className="mb-2 flex items-center justify-between">
            <button
              onClick={() => setSelected(new Set(accounts.items.map((a: SocialAccount) => a.id)))}
              className="text-xs text-muted hover:text-foreground"
            >
              Select all {accounts.total} loaded accounts
            </button>
            <span className="text-xs text-muted">{selected.size} selected</span>
          </div>
          <div className="max-h-56 overflow-y-auto">
            {accounts.items.map((a: SocialAccount) => (
              <label key={a.id} className="flex items-center gap-2 py-1 text-sm">
                <input type="checkbox" checked={selected.has(a.id)} onChange={() => toggleSelected(a.id)} />
                {a.displayName} <span className="text-muted">({a.platform})</span>
              </label>
            ))}
          </div>
          <button
            onClick={handleAssign}
            disabled={assigning || selected.size === 0}
            className="mt-3 rounded bg-foreground px-3 py-1.5 text-sm font-medium text-background disabled:opacity-50"
          >
            {assigning ? "Assigning…" : `Assign ${selected.size} account(s)`}
          </button>
          {assignError && <p className="mt-2 text-sm text-red-400">{assignError}</p>}
          {assignResult && (
            <p className="mt-2 text-xs text-muted">
              Assigned {assignResult.assigned} of {assignResult.requested}
              {assignResult.skipped.length > 0 ? ` (${assignResult.skipped.length} skipped)` : ""}.
            </p>
          )}
        </div>
      )}

      <div className="rounded border border-border bg-surface">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-border text-muted">
              <th className="px-4 py-2 font-normal">Account</th>
              <th className="px-4 py-2 font-normal">Platform</th>
              <th className="px-4 py-2 font-normal">Status</th>
              <th className="px-4 py-2 font-normal">Published post</th>
              <th className="px-4 py-2 font-normal">Analytics</th>
              <th className="px-4 py-2 font-normal"></th>
            </tr>
          </thead>
          <tbody>
            {targets && targets.items.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-center text-muted">
                  No target accounts assigned yet.
                </td>
              </tr>
            )}
            {targets?.items.map((t) => (
              <tr key={t.id} className="border-b border-border last:border-0 align-top">
                <td className="px-4 py-2">{t.socialAccount.displayName}</td>
                <td className="px-4 py-2">{t.socialAccount.platform}</td>
                <td className="px-4 py-2">
                  {t.status === "PUBLISHED" && t.deliveryNote ? (
                    <span className="rounded bg-yellow-950/40 px-1.5 py-0.5 text-xs font-medium text-yellow-400">
                      Sent — action required
                    </span>
                  ) : (
                    <JobStatusBadge status={t.status} />
                  )}
                  {t.status === "FAILED" && t.errorMessage && (
                    <p className="mt-1 max-w-xs text-xs text-red-400">{t.errorMessage}</p>
                  )}
                  {t.attemptCount > 0 && (
                    <AttemptsToggle contentId={contentId} socialAccountId={t.socialAccountId} attemptCount={t.attemptCount} />
                  )}
                </td>
                <td className="px-4 py-2">
                  {t.deliveryNote ? (
                    <p className="max-w-xs text-xs text-muted">{t.deliveryNote}</p>
                  ) : t.externalPostUrl ? (
                    <a href={t.externalPostUrl} target="_blank" rel="noreferrer" className="text-accent hover:underline">
                      View post
                    </a>
                  ) : t.externalPostId ? (
                    <span className="text-muted">{t.externalPostId}</span>
                  ) : (
                    <span className="text-muted">—</span>
                  )}
                </td>
                <td className="px-4 py-2">
                  {t.status === "PUBLISHED" ? (
                    <MetricsCell contentId={contentId} socialAccountId={t.socialAccountId} canEdit={canEdit} />
                  ) : (
                    <span className="text-muted">—</span>
                  )}
                </td>
                <td className="px-4 py-2">
                  <div className="flex items-center gap-3">
                    {canEdit && t.status === "FAILED" && (
                      <button
                        onClick={() => handleRetry(t.socialAccountId)}
                        disabled={retrying === t.socialAccountId}
                        className="text-xs text-accent hover:underline disabled:opacity-50"
                      >
                        {retrying === t.socialAccountId ? "Retrying…" : "Retry"}
                      </button>
                    )}
                    {canEdit && (t.status === "PENDING" || t.status === "FAILED") && (
                      <button onClick={() => handleRemove(t.socialAccountId)} className="text-xs text-red-400 hover:underline">
                        Remove
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {canEdit && (
        <div className="mt-4 flex flex-wrap items-end gap-3">
          <form onSubmit={handleSchedule} className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1 text-sm">
              Schedule for
              <input
                type="datetime-local"
                required
                value={scheduledAt}
                onChange={(e) => setScheduledAt(e.target.value)}
                className="rounded border border-border bg-surface px-3 py-2 text-foreground outline-none focus:border-foreground"
              />
            </label>
            <button
              type="submit"
              disabled={scheduling || content._count.targets === 0}
              className="rounded bg-foreground px-3 py-2 text-sm font-medium text-background disabled:opacity-50"
            >
              {scheduling ? "Scheduling…" : "Schedule"}
            </button>
          </form>
          <button
            onClick={handlePublishNow}
            disabled={publishingNow || content._count.targets === 0}
            className="rounded border border-border px-3 py-2 text-sm disabled:opacity-50"
          >
            {publishingNow ? "Publishing…" : "Publish now"}
          </button>
        </div>
      )}
      {scheduleError && <p className="mt-2 text-sm text-red-400">{scheduleError}</p>}
      {publishNowError && <p className="mt-2 text-sm text-red-400">{publishNowError}</p>}
      {content.scheduledAt && (
        <p className="mt-2 text-sm text-muted">
          Currently scheduled for {new Date(content.scheduledAt).toLocaleString()} in your local time zone (
          {Intl.DateTimeFormat().resolvedOptions().timeZone}). The stored value is a single unambiguous UTC instant —
          this is just how it's displayed to you.
        </p>
      )}
    </section>
  );
}

function AttemptsToggle({
  contentId,
  socialAccountId,
  attemptCount,
}: {
  contentId: string;
  socialAccountId: string;
  attemptCount: number;
}) {
  const [open, setOpen] = useState(false);
  const [attempts, setAttempts] = useState<PublishAttempt[] | null>(null);

  async function toggle() {
    const next = !open;
    setOpen(next);
    if (next && !attempts) {
      const result = await apiGet<PublishAttempt[]>(`/api/content/${contentId}/targets/${socialAccountId}/attempts`);
      setAttempts(result);
    }
  }

  return (
    <div className="mt-1">
      <button onClick={toggle} className="text-xs text-muted hover:text-foreground hover:underline">
        {attemptCount} attempt(s) {open ? "▲" : "▼"}
      </button>
      {open && attempts && (
        <ul className="mt-1 flex max-w-xs flex-col gap-1 border-l border-border pl-2 text-xs text-muted">
          {attempts.map((a) => (
            <li key={a.id}>
              #{a.attemptNumber} <JobStatusBadge status={a.status} />
              {a.errorCode ? ` — ${a.errorCode}` : ""}
              {a.errorMessage ? `: ${a.errorMessage}` : ""}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function MetricsCell({
  contentId,
  socialAccountId,
  canEdit,
}: {
  contentId: string;
  socialAccountId: string;
  canEdit: boolean;
}) {
  const [snapshots, setSnapshots] = useState<PostMetricsSnapshot[] | null>(null);
  const [open, setOpen] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function load() {
    apiGet<PostMetricsSnapshot[]>(`/api/content/${contentId}/targets/${socialAccountId}/metrics`).then(setSnapshots);
  }
  useEffect(load, [contentId, socialAccountId]);

  async function handleSync() {
    setError(null);
    setSyncing(true);
    try {
      await apiPost(`/api/content/${contentId}/targets/${socialAccountId}/sync-analytics`);
      // Real fetch happens async in the worker — give it a moment, then
      // reload. This is a one-shot re-check, not a fabricated progress
      // indicator: if the sync hasn't landed yet, the count just stays
      // what it was, and "Sync analytics" is repeatable any time.
      setTimeout(load, 3000);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong.");
    } finally {
      setSyncing(false);
    }
  }

  const latest = snapshots && snapshots.length > 0 ? snapshots[snapshots.length - 1] : null;

  return (
    <div>
      {latest ? (
        <button onClick={() => setOpen((v) => !v)} className="text-xs hover:underline">
          {latest.viewCount ?? "—"} views {open ? "▲" : "▼"}
        </button>
      ) : (
        <span className="text-xs text-muted">Not synced</span>
      )}
      {canEdit && (
        <button
          onClick={handleSync}
          disabled={syncing}
          className="ml-2 text-xs text-accent hover:underline disabled:opacity-50"
        >
          {syncing ? "Syncing…" : "Sync analytics"}
        </button>
      )}
      {error && <p className="mt-1 text-xs text-red-400">{error}</p>}
      {open && snapshots && snapshots.length > 0 && (
        <ul className="mt-1 flex max-w-xs flex-col gap-1 border-l border-border pl-2 text-xs text-muted">
          {snapshots
            .slice()
            .reverse()
            .map((s) => (
              <li key={s.id}>
                {new Date(s.fetchedAt).toLocaleString()} — {s.viewCount ?? "—"} views, {s.likeCount ?? "—"} likes,{" "}
                {s.commentCount ?? "—"} comments, {s.shareCount ?? "—"} shares
              </li>
            ))}
        </ul>
      )}
    </div>
  );
}
