"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { apiPost, ApiError } from "@/lib/api";

/**
 * No preview endpoint exists for a reset token (unlike invitations) —
 * apps/api only has POST /api/auth/reset-password, so this page is a
 * plain form that submits directly, matching that contract exactly.
 */
export default function ResetPasswordPage({ params }: { params: { token: string } }) {
  const [password, setPassword] = useState("");
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      // Deliberately does not establish a session on success (matches the
      // API: a reset logs every existing session out, it doesn't log the
      // requester back in) — so this links to /login, not /team.
      await apiPost<{ passwordReset: true }>("/api/auth/reset-password", {
        token: params.token,
        password,
      });
      setDone(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center p-8">
      <div className="w-full max-w-sm rounded border border-border bg-surface p-8">
        <h1 className="mb-6 text-xl font-semibold tracking-tight">Set a new password</h1>
        {done ? (
          <div className="flex flex-col gap-4">
            <p className="text-sm text-foreground">
              Your password has been reset. Every existing session has been signed out — please sign in again.
            </p>
            <Link
              href="/login"
              className="rounded bg-foreground px-3 py-2 text-center text-sm font-medium text-background"
            >
              Go to sign in
            </Link>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <label className="flex flex-col gap-1 text-sm">
              New password
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
            {error && <p className="text-sm text-red-400">{error}</p>}
            <button
              type="submit"
              disabled={submitting}
              className="mt-2 rounded bg-foreground px-3 py-2 text-sm font-medium text-background disabled:opacity-50"
            >
              {submitting ? "Resetting…" : "Reset password"}
            </button>
          </form>
        )}
      </div>
    </main>
  );
}
