export const metadata = { title: "Privacy Policy — Socialith" };

export default function PrivacyPage() {
  return (
    <main className="mx-auto max-w-2xl px-6 py-12 text-sm leading-relaxed text-foreground">
      <h1 className="mb-2 text-2xl font-semibold tracking-tight">Privacy Policy</h1>
      <p className="mb-8 text-muted">Last updated: September 2026</p>

      <p className="mb-6">
        This Privacy Policy explains what information Socialith collects, why, and how it is
        protected — including the information collected when you connect a TikTok, Instagram, or
        YouTube account.
      </p>

      <h2 className="mb-2 mt-8 text-lg font-semibold">1. Information we collect</h2>
      <ul className="mb-6 list-disc space-y-2 pl-5">
        <li>
          <strong>Account information:</strong> your name, email address, and organization
          membership, used to operate your Socialith account.
        </li>
        <li>
          <strong>Connected platform profile information:</strong> when you connect a TikTok,
          Instagram, or YouTube account via that platform&apos;s official OAuth flow, we retrieve
          basic profile information (such as your account ID, username/handle, display name,
          avatar, and follower count) so Socialith can identify and display the connected account
          inside your workspace.
        </li>
        <li>
          <strong>OAuth authorization credentials:</strong> the access and refresh tokens issued
          by the platform when you authorize a connection. These are encrypted at rest
          (AES-256-GCM) and are used only to perform the actions you request on your own connected
          account (for example, publishing a video you created through Socialith, or reading its
          public performance metrics) — never for any other account or purpose.
        </li>
        <li>
          <strong>Content you upload:</strong> media files, captions, and scheduling information
          you provide for publishing.
        </li>
      </ul>

      <h2 className="mb-2 mt-8 text-lg font-semibold">2. How we use TikTok Login Kit and Content Posting API data</h2>
      <p className="mb-6">
        The <code>user.info.basic</code> scope is used only to retrieve basic information about
        the authorized TikTok account so Socialith can identify and display the connected account
        inside your workspace. The <code>video.publish</code> scope is used only when you
        explicitly request a video to be published to your connected TikTok account — Socialith
        never initiates a publish without your action. We do not sell or share your TikTok data
        with third parties for advertising or any purpose unrelated to providing the Socialith
        service you requested.
      </p>

      <h2 className="mb-2 mt-8 text-lg font-semibold">3. How long we keep your data</h2>
      <p className="mb-6">
        Connected-account credentials are retained until you disconnect the account (at which
        point the stored access and refresh tokens are permanently deleted) or until you delete
        your Socialith organization. Content and analytics history are retained for as long as
        your organization&apos;s account remains active, unless you request earlier deletion.
      </p>

      <h2 className="mb-2 mt-8 text-lg font-semibold">4. Security</h2>
      <p className="mb-6">
        OAuth tokens are encrypted at rest and are never exposed in API responses, log output, or
        the Socialith web interface. Access to connected-account data is scoped to your own
        organization and role.
      </p>

      <h2 className="mb-2 mt-8 text-lg font-semibold">5. Your choices</h2>
      <p className="mb-6">
        You can disconnect any connected platform account at any time from the Accounts page,
        which immediately revokes and deletes Socialith&apos;s stored credential for that account.
        You can also request deletion of your Socialith account and associated data by contacting
        us.
      </p>

      <h2 className="mb-2 mt-8 text-lg font-semibold">6. Contact</h2>
      <p className="mb-6">For privacy questions or data-deletion requests, contact: privacy@socialith.co</p>

      <p className="mt-10 text-xs text-muted">
        This document is a working draft intended to describe Socialith&apos;s actual current data
        practices accurately (in particular for platform app-review purposes) and has not yet been
        reviewed by legal counsel — treat it as provisional until formally reviewed.
      </p>
    </main>
  );
}
