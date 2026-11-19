"use client";

import { useEffect, useState, type FormEvent } from "react";
import {
  apiGet,
  apiPost,
  ApiError,
  INVITABLE_ROLES,
  type CreateInvitationResult,
  type Role,
  type TeamListing,
} from "@/lib/api";
import { useCurrentUser } from "@/lib/auth-context";

export default function TeamPage() {
  const me = useCurrentUser();
  const [team, setTeam] = useState<TeamListing | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<Role>("VIEWER");
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [devAcceptUrl, setDevAcceptUrl] = useState<string | null>(null);
  const [inviting, setInviting] = useState(false);

  async function loadTeam() {
    const listing = await apiGet<TeamListing>("/api/team");
    setTeam(listing);
  }

  useEffect(() => {
    loadTeam().catch((err) => setLoadError(err instanceof ApiError ? err.message : "Something went wrong."));
  }, []);

  async function handleInvite(e: FormEvent) {
    e.preventDefault();
    setInviteError(null);
    setDevAcceptUrl(null);
    setInviting(true);
    try {
      const result = await apiPost<CreateInvitationResult>("/api/team/invitations", {
        email: inviteEmail,
        role: inviteRole,
      });
      setInviteEmail("");
      if (result.devAcceptUrl) setDevAcceptUrl(result.devAcceptUrl);
      await loadTeam();
    } catch (err) {
      setInviteError(err instanceof ApiError ? err.message : "Something went wrong.");
    } finally {
      setInviting(false);
    }
  }

  if (loadError) {
    return <p className="text-sm text-red-400">{loadError}</p>;
  }

  if (!team) {
    return <p className="text-sm text-muted">Loading…</p>;
  }

  // Mirrors @socialith/auth's canManageTeam (OWNER/ADMIN) — the invite
  // form below is only a convenience; POST /api/team/invitations enforces
  // this same rule server-side regardless of what this page shows.
  const canManageTeam = me.role === "OWNER" || me.role === "ADMIN";

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="mb-6 text-xl font-semibold tracking-tight">Team</h1>

      <section className="mb-8 rounded border border-border bg-surface">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-border text-muted">
              <th className="px-4 py-2 font-normal">Name</th>
              <th className="px-4 py-2 font-normal">Email</th>
              <th className="px-4 py-2 font-normal">Role</th>
              <th className="px-4 py-2 font-normal">Status</th>
            </tr>
          </thead>
          <tbody>
            {team.members.map((member) => (
              <tr key={member.id} className="border-b border-border last:border-0">
                <td className="px-4 py-2">{member.name}</td>
                <td className="px-4 py-2">{member.email}</td>
                <td className="px-4 py-2">{member.role}</td>
                <td className="px-4 py-2">{member.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {team.pendingInvitations.length > 0 && (
        <section className="mb-8">
          <h2 className="mb-2 text-sm font-medium text-muted">Pending invitations</h2>
          <ul className="flex flex-col gap-1 text-sm">
            {team.pendingInvitations.map((inv) => (
              <li key={inv.id} className="text-muted">
                {inv.email} — {inv.role}
              </li>
            ))}
          </ul>
        </section>
      )}

      {canManageTeam && (
        <section className="rounded border border-border bg-surface p-6">
          <h2 className="mb-4 text-sm font-medium">Invite a member</h2>
          <form onSubmit={handleInvite} className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1 text-sm">
              Email
              <input
                type="email"
                required
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                className="rounded border border-border bg-background px-3 py-2 text-foreground outline-none focus:border-foreground"
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              Role
              <select
                value={inviteRole}
                onChange={(e) => setInviteRole(e.target.value as Role)}
                className="rounded border border-border bg-background px-3 py-2 text-foreground outline-none focus:border-foreground"
              >
                {INVITABLE_ROLES.map((role) => (
                  <option key={role} value={role}>
                    {role}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="submit"
              disabled={inviting}
              className="rounded bg-foreground px-3 py-2 text-sm font-medium text-background disabled:opacity-50"
            >
              {inviting ? "Inviting…" : "Send invite"}
            </button>
          </form>
          {inviteError && <p className="mt-3 text-sm text-red-400">{inviteError}</p>}
          {devAcceptUrl && (
            <p className="mt-3 break-all text-sm text-muted">
              Dev-only accept link (no email provider connected yet):{" "}
              <a href={devAcceptUrl} className="underline">
                {devAcceptUrl}
              </a>
            </p>
          )}
        </section>
      )}
    </div>
  );
}
