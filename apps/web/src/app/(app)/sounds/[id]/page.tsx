"use client";

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import {
  apiGet,
  apiPatch,
  apiPost,
  buildQueryString,
  ApiError,
  type ListContentResult,
  type MetricsRollup,
  type SoundDetail,
} from "@/lib/api";
import { useCurrentUser } from "@/lib/auth-context";

export default function SoundDetailPage({ params }: { params: { id: string } }) {
  const me = useCurrentUser();
  const canEdit = me.role !== "VIEWER";

  const [sound, setSound] = useState<SoundDetail | null>(null);
  const [content, setContent] = useState<ListContentResult | null>(null);
  const [metrics, setMetrics] = useState<MetricsRollup | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [title, setTitle] = useState("");
  const [artist, setArtist] = useState("");
  const [soundUrl, setSoundUrl] = useState("");
  const [externalSoundId, setExternalSoundId] = useState("");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [archiving, setArchiving] = useState(false);

  function load() {
    apiGet<SoundDetail>(`/api/sounds/${params.id}`)
      .then((s) => {
        setSound(s);
        setTitle(s.title);
        setArtist(s.artist ?? "");
        setSoundUrl(s.soundUrl ?? "");
        setExternalSoundId(s.externalSoundId ?? "");
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : "Something went wrong."));
    apiGet<ListContentResult>(`/api/content${buildQueryString({ soundId: params.id, pageSize: 50 })}`).then(setContent);
    apiGet<MetricsRollup>(`/api/analytics/sounds/${params.id}`).then(setMetrics);
  }

  useEffect(load, [params.id]);

  async function handleSave(e: FormEvent) {
    e.preventDefault();
    if (!sound) return;
    setSaveError(null);
    setSaving(true);
    try {
      const updated = await apiPatch<SoundDetail>(`/api/sounds/${params.id}`, {
        title,
        artist: artist || null,
        soundUrl: soundUrl || null,
        externalSoundId: externalSoundId || null,
      });
      setSound({ ...updated, usage: sound.usage });
    } catch (err) {
      setSaveError(err instanceof ApiError ? err.message : "Something went wrong.");
    } finally {
      setSaving(false);
    }
  }

  async function handleArchive() {
    setArchiving(true);
    try {
      await apiPost(`/api/sounds/${params.id}/archive`);
      load();
    } finally {
      setArchiving(false);
    }
  }

  if (error) return <p className="text-sm text-red-400">{error}</p>;
  if (!sound) return <p className="text-sm text-muted">Loading…</p>;

  return (
    <div className="max-w-2xl">
      <Link href="/sounds" className="mb-4 inline-block text-sm text-muted hover:text-foreground">
        ← Music / Sounds
      </Link>

      <div className="mb-6 rounded border border-border bg-surface p-6">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">{sound.title}</h1>
            {sound.artist && <p className="text-sm text-muted">{sound.artist}</p>}
          </div>
          <span className="text-sm text-muted">
            {sound.platform} — {sound.status}
          </span>
        </div>

        {canEdit ? (
          <form onSubmit={handleSave} className="flex flex-col gap-3">
            <div className="flex flex-wrap gap-3">
              <label className="flex flex-1 flex-col gap-1 text-sm">
                Title
                <input
                  type="text"
                  required
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  className="rounded border border-border bg-background px-3 py-2 text-foreground outline-none focus:border-foreground"
                />
              </label>
              <label className="flex flex-1 flex-col gap-1 text-sm">
                Artist
                <input
                  type="text"
                  value={artist}
                  onChange={(e) => setArtist(e.target.value)}
                  className="rounded border border-border bg-background px-3 py-2 text-foreground outline-none focus:border-foreground"
                />
              </label>
            </div>
            <div className="flex flex-wrap gap-3">
              <label className="flex flex-1 flex-col gap-1 text-sm">
                Sound URL
                <input
                  type="url"
                  value={soundUrl}
                  onChange={(e) => setSoundUrl(e.target.value)}
                  className="rounded border border-border bg-background px-3 py-2 text-foreground outline-none focus:border-foreground"
                />
              </label>
              <label className="flex flex-1 flex-col gap-1 text-sm">
                Sound / Music ID
                <input
                  type="text"
                  value={externalSoundId}
                  onChange={(e) => setExternalSoundId(e.target.value)}
                  className="rounded border border-border bg-background px-3 py-2 text-foreground outline-none focus:border-foreground"
                />
              </label>
            </div>
            {saveError && <p className="text-sm text-red-400">{saveError}</p>}
            <div className="flex items-center gap-3">
              <button
                type="submit"
                disabled={saving}
                className="w-fit rounded bg-foreground px-3 py-2 text-sm font-medium text-background disabled:opacity-50"
              >
                {saving ? "Saving…" : "Save"}
              </button>
              {sound.status === "ACTIVE" && (
                <button
                  type="button"
                  onClick={handleArchive}
                  disabled={archiving}
                  className="text-sm text-red-400 hover:underline disabled:opacity-50"
                >
                  {archiving ? "Archiving…" : "Archive sound"}
                </button>
              )}
            </div>
          </form>
        ) : (
          <dl className="grid grid-cols-2 gap-2 text-sm">
            {sound.soundUrl && (
              <>
                <dt className="text-muted">Sound URL</dt>
                <dd>
                  <a href={sound.soundUrl} target="_blank" rel="noreferrer" className="text-accent hover:underline">
                    {sound.soundUrl}
                  </a>
                </dd>
              </>
            )}
            {sound.externalSoundId && (
              <>
                <dt className="text-muted">Sound / Music ID</dt>
                <dd>{sound.externalSoundId}</dd>
              </>
            )}
          </dl>
        )}
      </div>

      <h2 className="mb-3 text-sm font-medium text-muted">Usage</h2>
      <div className="mb-6 grid grid-cols-3 gap-3">
        <StatTile label="Content items" value={sound.usage.contentCount} />
        <StatTile label="Target accounts" value={sound.usage.targetCount} />
        <StatTile label="Published to" value={sound.usage.publishedTargetCount} />
      </div>

      <h2 className="mb-3 text-sm font-medium text-muted">Performance (published posts only)</h2>
      {metrics && (
        <div className="mb-6 grid grid-cols-4 gap-3">
          <StatTile label="Views" value={metrics.viewCount} />
          <StatTile label="Likes" value={metrics.likeCount} />
          <StatTile label="Comments" value={metrics.commentCount} />
          <StatTile label="Shares" value={metrics.shareCount} />
        </div>
      )}
      {metrics && metrics.syncedCount === 0 && (
        <p className="mb-6 text-sm text-muted">
          No real metrics have been synced yet — trigger &ldquo;Sync analytics&rdquo; on a published target from its
          content page.
        </p>
      )}

      <h2 className="mb-3 text-sm font-medium text-muted">Content using this sound</h2>
      <div className="rounded border border-border bg-surface">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-border text-muted">
              <th className="px-4 py-2 font-normal">Caption</th>
              <th className="px-4 py-2 font-normal">Status</th>
              <th className="px-4 py-2 font-normal">Targets</th>
            </tr>
          </thead>
          <tbody>
            {content && content.items.length === 0 && (
              <tr>
                <td colSpan={3} className="px-4 py-6 text-center text-muted">
                  No content uses this sound yet.
                </td>
              </tr>
            )}
            {content?.items.map((item) => (
              <tr key={item.id} className="border-b border-border last:border-0 hover:bg-background/40">
                <td className="px-4 py-2">
                  <Link href={`/content/${item.id}`} className="hover:underline">
                    {item.caption ?? <span className="text-muted">(no caption)</span>}
                  </Link>
                </td>
                <td className="px-4 py-2">{item.status}</td>
                <td className="px-4 py-2 text-muted">{item._count.targets}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function StatTile({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded border border-border bg-surface p-4">
      <div className="text-2xl font-semibold tracking-tight">{value.toLocaleString()}</div>
      <div className="text-xs text-muted">{label}</div>
    </div>
  );
}
