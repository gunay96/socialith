export const metadata = { title: "Terms of Service — Socialith" };

export default function TermsPage() {
  return (
    <main className="mx-auto max-w-2xl px-6 py-12 text-sm leading-relaxed text-foreground">
      <h1 className="mb-2 text-2xl font-semibold tracking-tight">Terms of Service</h1>
      <p className="mb-8 text-muted">Last updated: September 2026</p>

      <p className="mb-6">
        Socialith (&quot;Socialith&quot;, &quot;we&quot;, &quot;us&quot;) is a web-based social media
        management platform that allows creators and businesses to securely connect and manage
        their social media accounts from one centralized workspace. These Terms of Service
        (&quot;Terms&quot;) govern your access to and use of Socialith.
      </p>

      <h2 className="mb-2 mt-8 text-lg font-semibold">1. Your account</h2>
      <p className="mb-6">
        You must provide accurate information when creating a Socialith account and are
        responsible for keeping your login credentials secure. You are responsible for all
        activity that occurs under your account.
      </p>

      <h2 className="mb-2 mt-8 text-lg font-semibold">2. Connecting third-party platform accounts</h2>
      <p className="mb-6">
        Socialith lets you connect your own social media accounts (currently TikTok, Instagram,
        and YouTube) via each platform&apos;s official OAuth authorization flow. You explicitly
        authorize each connection through that platform&apos;s own consent screen. Socialith only
        acts on a connected account within the scope you authorized (e.g. reading basic profile
        information, or publishing content you create and submit through Socialith), and only
        when you request an action — Socialith never publishes to a connected account without
        your explicit request. You can disconnect any account at any time from the Accounts page;
        doing so immediately revokes Socialith&apos;s stored access to that account.
      </p>

      <h2 className="mb-2 mt-8 text-lg font-semibold">3. Content you publish</h2>
      <p className="mb-6">
        You are solely responsible for the content you create, upload, schedule, or publish
        through Socialith, and for ensuring it complies with the terms of every platform you
        publish to. Socialith does not review or endorse content before it is published on your
        behalf.
      </p>

      <h2 className="mb-2 mt-8 text-lg font-semibold">4. Acceptable use</h2>
      <p className="mb-6">
        You agree not to use Socialith to violate any connected platform&apos;s terms of service,
        to publish unlawful or infringing content, or to attempt to access another organization&apos;s
        data or accounts.
      </p>

      <h2 className="mb-2 mt-8 text-lg font-semibold">5. Termination</h2>
      <p className="mb-6">
        You may stop using Socialith and disconnect your accounts at any time. We may suspend or
        terminate access for accounts that violate these Terms.
      </p>

      <h2 className="mb-2 mt-8 text-lg font-semibold">6. Disclaimer &amp; limitation of liability</h2>
      <p className="mb-6">
        Socialith is provided &quot;as is&quot;, without warranties of any kind. Socialith is not
        liable for actions taken by third-party platforms (including TikTok, Instagram, and
        YouTube) on connected accounts, including suspensions, rate limiting, or content removal
        decisions made by those platforms.
      </p>

      <h2 className="mb-2 mt-8 text-lg font-semibold">7. Changes to these Terms</h2>
      <p className="mb-6">
        We may update these Terms from time to time. Continued use of Socialith after a change
        constitutes acceptance of the updated Terms.
      </p>

      <h2 className="mb-2 mt-8 text-lg font-semibold">8. Contact</h2>
      <p className="mb-6">Questions about these Terms can be sent to the contact address listed on our Privacy Policy page.</p>

      <p className="mt-10 text-xs text-muted">
        This document is a working draft intended to describe Socialith&apos;s actual current
        functionality accurately (in particular for platform app-review purposes) and has not yet
        been reviewed by legal counsel — treat it as provisional until formally reviewed.
      </p>
    </main>
  );
}
