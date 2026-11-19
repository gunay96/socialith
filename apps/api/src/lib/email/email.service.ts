/**
 * Abstraction over "send this email" so the invitation and password-
 * reset flows never talk to a concrete provider directly. No real
 * provider is connected yet, and this must not be faked as if it were:
 * `ConsoleEmailService` below logs instead of sending, it does not
 * pretend to be a working SMTP/API client. Swap in a real
 * implementation (Resend, SES, Postmark, SMTP, whatever gets chosen)
 * behind this same interface in a later phase, selected via
 * `EMAIL_PROVIDER` (see @socialith/config) — nothing above this layer
 * (invitation/password-reset services) needs to change.
 */
export interface InvitationEmailParams {
  to: string;
  organizationName: string;
  role: string;
  invitedByName: string;
  /**
   * The full, one-time accept-invitation URL — contains the raw token.
   * Implementations must put this only in the email body itself, never
   * in a log line, metric tag, or anything else that isn't the message
   * sent to `to`.
   */
  acceptUrl: string;
}

export interface PasswordResetEmailParams {
  to: string;
  /**
   * The full, one-time reset URL — contains the raw token. Same rule as
   * InvitationEmailParams.acceptUrl: implementations must put this only
   * in the email body, never in a log line or anything else.
   */
  resetUrl: string;
  expiresAt: Date;
}

export interface EmailService {
  sendInvitation(params: InvitationEmailParams): Promise<void>;
  sendPasswordReset(params: PasswordResetEmailParams): Promise<void>;
  // Future methods land here as later phases need them, e.g.:
  //   sendPublishingFailureAlert(params: ...): Promise<void>;
}

/**
 * Development-only stand-in: logs that an invitation/reset email "would
 * be sent" and its one-time URL, via the structured logger — visible in
 * dev console output, never actually delivered anywhere. This is the
 * *only* place a developer can see the link without a real provider
 * connected: unlike invitation creation (an authenticated, admin-only
 * action, which also echoes its URL in the API response outside
 * production), password reset never puts its URL in the API response,
 * even in development — see services/password-reset.service.ts for why
 * that endpoint's response can't vary by outcome at all.
 */
export class ConsoleEmailService implements EmailService {
  constructor(private readonly logger: { info: (obj: Record<string, unknown>, msg: string) => void }) {}

  async sendInvitation(params: InvitationEmailParams): Promise<void> {
    this.logger.info(
      {
        to: params.to,
        organizationName: params.organizationName,
        role: params.role,
        invitedByName: params.invitedByName,
        acceptUrl: params.acceptUrl,
      },
      "[dev] Invitation email would be sent here (no real email provider is connected yet)",
    );
  }

  async sendPasswordReset(params: PasswordResetEmailParams): Promise<void> {
    this.logger.info(
      {
        to: params.to,
        resetUrl: params.resetUrl,
        expiresAt: params.expiresAt.toISOString(),
      },
      "[dev] Password reset email would be sent here (no real email provider is connected yet)",
    );
  }
}

let cachedEmailService: EmailService | null = null;

/**
 * Single place that decides which EmailService implementation is
 * active, based on `EMAIL_PROVIDER` (@socialith/config). Everything
 * else (invitation/password-reset services) calls this rather than
 * constructing an implementation itself, so wiring in a real provider
 * later is a one-function change: add a case here, add the new value
 * to `EMAIL_PROVIDER`'s enum in @socialith/config, nothing else moves.
 */
export function getEmailService(
  logger: { info: (obj: Record<string, unknown>, msg: string) => void },
  provider: "console" = "console",
): EmailService {
  if (!cachedEmailService) {
    switch (provider) {
      case "console":
        cachedEmailService = new ConsoleEmailService(logger);
        break;
      default:
        // Exhaustiveness guard — TypeScript would already flag an
        // unhandled provider value above as `provider` isn't `never`,
        // so this only fires if that check is ever bypassed.
        throw new Error(`Unsupported EMAIL_PROVIDER: ${provider as string}`);
    }
  }
  return cachedEmailService;
}
