"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { apiGet, apiPost, ApiError, type InvitationPreview, type SafeUser } from "@/lib/api";

export default function AcceptInvitationPage({ params }: { params: { token: string } }) {
  const router = useRouter();
  const [preview, setPreview] = useState<InvitationPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    apiGet<InvitationPreview>(`/api/team/invitations/${params.token}`)
      .then(setPreview)
      .catch((err) => setPreviewError(err instanceof ApiError ? err.message : "Something went wrong."));
  }, [params.token]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitError(null);
    setSubmitting(true);
    try {
      // Accepting establishes a session the same way login does, so the
      // next stop is the authenticated team page, not /login.
      await apiPost<SafeUser>(`/api/team/invitations/${params.token}`, { name, password });
      router.push("/team");
    } catch (err) {
      setSubmitError(err instanceof ApiError ? err.message : "Something went wrong.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center p-8">
      <div className="w-full max-w-sm rounded border border-border bg-surface p-8">
        <h1 className="mb-6 text-xl font-semibold tracking-tight">Join your team</h1>

        {previewError && <p className="text-sm text-red-400">{previewError}</p>}

        {!previewError && !preview && <p className="text-sm text-muted">Loading invitation…</p>}

        {preview && (
          <>
            <p className="mb-6 text-sm text-muted">
              You&apos;ve been invited to join <span className="text-foreground">{preview.organizationName}</span> as{" "}
              <span className="text-foreground">{preview.role}</span> ({preview.email}).
            </p>
            <form onSubmit={handleSubmit} className="flex flex-col gap-4">
              <label className="flex flex-col gap-1 text-sm">
                Your name
                <input
                  type="text"
                  required
                  autoComplete="name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="rounded border border-border bg-background px-3 py-2 text-foreground outline-none focus:border-foreground"
                />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                Password
                <input
                  type="password"
                  required
                  minLength={12}
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="rounded border border-border bg-background px-3 py-2 text-foreground outline-none focus:border-foreground"
                />
                <span className="text-xs text-muted">At least 12 characters.</span>
              </label>
              {submitError && <p className="text-sm text-red-400">{submitError}</p>}
              <button
                type="submit"
                disabled={submitting}
                className="mt-2 rounded bg-foreground px-3 py-2 text-sm font-medium text-background disabled:opacity-50"
              >
                {submitting ? "Joining…" : "Accept & join"}
              </button>
            </form>
          </>
        )}
      </div>
    </main>
  );
}
