"use client";

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import {
  apiGet,
  apiPost,
  buildQueryString,
  ApiError,
  PLATFORMS,
  type Platform,
  type Sound,
  type ListSoundsResult,
} from "@/lib/api";
import { useCurrentUser } from "@/lib/auth-context";

const PAGE_SIZE = 25;

export default function SoundsPage() {
  const me = useCurrentUser();
  const canEdit = me.role !== "VIEWER";

  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [platform, setPlatform] = useState<Platform | "">("");
  const [artistInput, setArtistInput] = useState("");
  const [artist, setArtist] = useState("");
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<ListSoundsResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [showCreate, setShowCreate] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newArtist, setNewArtist] = useState("");
  const [newPlatform, setNewPlatform] = useState<Platform>("TIKTOK");
  const [newExternalSoundId, setNewExternalSoundId] = useState("");
  const [newSoundUrl, setNewSoundUrl] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(searchInput);
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  useEffect(() => {
    const timer = setTimeout(() => {
      setArtist(artistInput);
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [artistInput]);

  function load() {
    const query = buildQueryString({
      search: search || undefined,
      platform: platform || undefined,
      artist: artist || undefined,
      page,
      pageSize: PAGE_SIZE,
    });
    apiGet<ListSoundsResult>(`/api/sounds${query}`)
      .then(setResult)
      .catch((err) => setError(err instanceof ApiError ? err.message : "Something went wrong."));
  }

  useEffect(load, [search, platform, artist, page]);

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    setCreateError(null);
    setCreating(true);
    try {
      await apiPost<Sound>("/api/sounds", {
        title: newTitle,
        artist: newArtist || undefined,
        platform: newPlatform,
        externalSoundId: newExternalSoundId || undefined,
        soundUrl: newSoundUrl || undefined,
      });
      setNewTitle("");
      setNewArtist("");
      setNewExternalSoundId("");
      setNewSoundUrl("");
      setShowCreate(false);
      setPage(1);
      load();
    } catch (err) {
      setCreateError(err instanceof ApiError ? err.message : "Something went wrong.");
    } finally {
      setCreating(false);
    }
  }

  const totalPages = result ? Math.max(1, Math.ceil(result.total / result.pageSize)) : 1;

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <h1 className="text-xl font-semibold tracking-tight">Music / Sounds</h1>
        {canEdit && (
          <button
            onClick={() => setShowCreate((v) => !v)}
            className="rounded bg-foreground px-3 py-2 text-sm font-medium text-background"
          >
            {showCreate ? "Cancel" : "New sound"}
          </button>
        )}
      </div>
      <p className="mb-6 text-sm text-muted">
        A reusable library of platform sounds/tracks for music-seeding campaigns — the same Sound can be attached to
        many Content items across many target accounts.
      </p>

      {showCreate && (
        <form onSubmit={handleCreate} className="mb-6 flex flex-col gap-3 rounded border border-border bg-surface p-4">
          <div className="flex flex-wrap gap-3">
            <label className="flex flex-1 flex-col gap-1 text-sm">
              Title
              <input
                type="text"
                required
                placeholder="Alroca - X"
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                className="rounded border border-border bg-background px-3 py-2 text-foreground outline-none focus:border-foreground"
              />
            </label>
            <label className="flex flex-1 flex-col gap-1 text-sm">
              Artist
              <input
                type="text"
                placeholder="Alroca"
                value={newArtist}
                onChange={(e) => setNewArtist(e.target.value)}
                className="rounded border border-border bg-background px-3 py-2 text-foreground outline-none focus:border-foreground"
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              Platform
              <select
                value={newPlatform}
                onChange={(e) => setNewPlatform(e.target.value as Platform)}
                className="rounded border border-border bg-background px-3 py-2 text-foreground outline-none focus:border-foreground"
              >
                {PLATFORMS.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="flex flex-wrap gap-3">
            <label className="flex flex-1 flex-col gap-1 text-sm">
              Sound URL
              <input
                type="url"
                placeholder="https://www.tiktok.com/music/…"
                value={newSoundUrl}
                onChange={(e) => setNewSoundUrl(e.target.value)}
                className="rounded border border-border bg-background px-3 py-2 text-foreground outline-none focus:border-foreground"
              />
            </label>
            <label className="flex flex-1 flex-col gap-1 text-sm">
              Sound / Music ID
              <input
                type="text"
                placeholder="7123456789012345678"
                value={newExternalSoundId}
                onChange={(e) => setNewExternalSoundId(e.target.value)}
                className="rounded border border-border bg-background px-3 py-2 text-foreground outline-none focus:border-foreground"
              />
            </label>
          </div>
          {createError && <p className="text-sm text-red-400">{createError}</p>}
          <button
            type="submit"
            disabled={creating}
            className="w-fit rounded bg-foreground px-3 py-2 text-sm font-medium text-background disabled:opacity-50"
          >
            {creating ? "Creating…" : "Add sound"}
          </button>
        </form>
      )}

      <div className="mb-4 flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-sm">
          Search
          <input
            type="text"
            placeholder="Title or artist…"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            className="w-56 rounded border border-border bg-surface px-3 py-2 text-foreground outline-none focus:border-foreground"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Artist
          <input
            type="text"
            placeholder="Filter by artist…"
            value={artistInput}
            onChange={(e) => setArtistInput(e.target.value)}
            className="w-40 rounded border border-border bg-surface px-3 py-2 text-foreground outline-none focus:border-foreground"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Platform
          <select
            value={platform}
            onChange={(e) => {
              setPlatform(e.target.value as Platform | "");
              setPage(1);
            }}
            className="rounded border border-border bg-surface px-3 py-2 text-foreground outline-none focus:border-foreground"
          >
            <option value="">All</option>
            {PLATFORMS.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>
      </div>

      {error && <p className="mb-4 text-sm text-red-400">{error}</p>}
      {!result && !error && <p className="text-sm text-muted">Loading…</p>}

      {result && (
        <>
          <div className="rounded border border-border bg-surface">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-border text-muted">
                  <th className="px-4 py-2 font-normal">Title</th>
                  <th className="px-4 py-2 font-normal">Artist</th>
                  <th className="px-4 py-2 font-normal">Platform</th>
                  <th className="px-4 py-2 font-normal">Status</th>
                </tr>
              </thead>
              <tbody>
                {result.items.length === 0 && (
                  <tr>
                    <td colSpan={4} className="px-4 py-6 text-center text-muted">
                      No sounds match these filters.
                    </td>
                  </tr>
                )}
                {result.items.map((s) => (
                  <tr key={s.id} className="border-b border-border last:border-0 hover:bg-background/40">
                    <td className="px-4 py-2">
                      <Link href={`/sounds/${s.id}`} className="hover:underline">
                        {s.title}
                      </Link>
                    </td>
                    <td className="px-4 py-2 text-muted">{s.artist ?? "—"}</td>
                    <td className="px-4 py-2">{s.platform}</td>
                    <td className="px-4 py-2 text-muted">{s.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="mt-4 flex items-center justify-between text-sm text-muted">
            <span>
              {result.total} sound{result.total === 1 ? "" : "s"} — page {result.page} of {totalPages}
            </span>
            <div className="flex gap-2">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page <= 1}
                className="rounded border border-border px-3 py-1.5 disabled:opacity-40"
              >
                Previous
              </button>
              <button
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={page >= totalPages}
                className="rounded border border-border px-3 py-1.5 disabled:opacity-40"
              >
                Next
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
