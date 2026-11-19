"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { apiPost, ApiError } from "@/lib/api";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setMessage(null);
    setSubmitting(true);
    try {
      // The backend returns the exact same message whether or not the
      // email matched an eligible account — rendered verbatim, never
      // replaced with a more specific one, so this page can't become a
      // new enumeration signal the API itself was designed to avoid.
      const result = await apiPost<{ message: string }>("/api/auth/forgot-password", { email });
      setMessage(result.message);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center p-8">
      <div className="w-full max-w-sm rounded border border-border bg-surface p-8">
        <h1 className="mb-6 text-xl font-semibold tracking-tight">Reset your password</h1>
        {message ? (
          <p className="text-sm text-foreground">{message}</p>
        ) : (
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <label className="flex flex-col gap-1 text-sm">
              Email
              <input
                type="email"
                required
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="rounded border border-border bg-background px-3 py-2 text-foreground outline-none focus:border-foreground"
              />
            </label>
            {error && <p className="text-sm text-red-400">{error}</p>}
            <button
              type="submit"
              disabled={submitting}
              className="mt-2 rounded bg-foreground px-3 py-2 text-sm font-medium text-background disabled:opacity-50"
            >
              {submitting ? "Sending…" : "Send reset link"}
            </button>
          </form>
        )}
        <p className="mt-4 text-center text-sm text-muted">
          <Link href="/login" className="underline">
            Back to sign in
          </Link>
        </p>
      </div>
    </main>
  );
}
