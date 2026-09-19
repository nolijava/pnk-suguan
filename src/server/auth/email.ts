/**
 * Outbound email for account recovery (system update — Group 1).
 *
 * Deliberately minimal: ONE purpose (deliver a password-reset verification
 * code), ONE transport (SMTP via nodemailer), configured entirely through
 * environment variables. Nothing here logs, returns, or stores the code, the
 * credentials, or the SMTP URL.
 *
 * Fail-closed contract: when SMTP is not configured the send is a no-op that
 * reports `delivered: false`. The caller still answers with the SAME generic
 * message, so a misconfigured deployment cannot become an account-existence
 * oracle, and no code is ever handed to a client for an existing account.
 *
 * `PNK_PASSWORD_RESET_DEV_ECHO=true` is the ONLY way a code is ever written to
 * the server console. It is hard-disabled unless NODE_ENV is explicitly not
 * "production", and it is unset by default — production can never echo.
 */

export interface PasswordResetEmail {
  to: string;
  fullName: string;
  code: string;
  expiresInMinutes: number;
}

/** True only when SMTP is configured (URL or discrete host). */
export function isEmailConfigured(): boolean {
  return Boolean(smtpUrl() ?? smtpHost());
}

/** Explicit, non-production-only opt-in for local development. */
export function passwordResetDevEchoEnabled(): boolean {
  return (
    process.env.NODE_ENV !== "production" &&
    process.env.PNK_PASSWORD_RESET_DEV_ECHO === "true"
  );
}

/** Why email could not be sent — safe for server logs (never contains secrets). */
export function emailConfigurationProblem(): string | null {
  if (isEmailConfigured()) return null;
  if (smtpUrl() === "" || smtpHost() === "") {
    return "PNK_SMTP_URL (or PNK_SMTP_HOST) is set but empty";
  }
  return "SMTP is not configured (set PNK_SMTP_URL to enable recovery emails)";
}

function smtpUrl(): string | undefined {
  const url = process.env.PNK_SMTP_URL?.trim();
  return url ? url : undefined;
}

function smtpHost(): string | undefined {
  const host = process.env.PNK_SMTP_HOST?.trim();
  return host ? host : undefined;
}

function fromAddress(): string {
  return process.env.PNK_SMTP_FROM?.trim() || "PNK Suguan <no-reply@localhost>";
}

/** Lazily constructed transport. Import failures fail closed (never throw outward). */
let cachedTransport: unknown = null;
async function getTransport(): Promise<{ sendMail: (opts: unknown) => Promise<unknown> } | null> {
  if (!isEmailConfigured()) return null;
  if (cachedTransport) return cachedTransport as { sendMail: (opts: unknown) => Promise<unknown> };
  try {
    const nodemailer = (await import("nodemailer")).default;
    const options: Record<string, unknown> = {};
    const url = smtpUrl();
    if (url) {
      const transport = nodemailer.createTransport(url);
      cachedTransport = transport;
      return transport as unknown as { sendMail: (opts: unknown) => Promise<unknown> };
    }
    options.host = smtpHost();
    const port = Number(process.env.PNK_SMTP_PORT ?? 587);
    options.port = Number.isFinite(port) ? port : 587;
    options.secure = process.env.PNK_SMTP_SECURE === "true" || options.port === 465;
    const user = process.env.PNK_SMTP_USER?.trim();
    const pass = process.env.PNK_SMTP_PASS;
    if (user && pass) options.auth = { user, pass };
    const transport = nodemailer.createTransport(options);
    cachedTransport = transport;
    return transport as unknown as { sendMail: (opts: unknown) => Promise<unknown> };
  } catch {
    // Module missing or transport rejected the configuration — fail closed.
    return null;
  }
}

function body(payload: PasswordResetEmail): string {
  return [
    `Hello ${payload.fullName},`,
    "",
    "A password reset was requested for your PNK Suguan System account.",
    "",
    `Your verification code is: ${payload.code}`,
    "",
    `The code expires in ${payload.expiresInMinutes} minutes and can be used once.`,
    "",
    "If you did not request this, you can ignore this email — your current password still works.",
    "Never share this code with anyone; PNK staff will never ask you for it.",
    "",
    "— PNK Suguan System",
  ].join("\n");
}

/**
 * Deliver the verification code. Resolves `delivered: false` (never throws) when
 * email is unavailable, so the HTTP response cannot depend on SMTP health.
 */
export async function sendPasswordResetCode(payload: PasswordResetEmail): Promise<{ delivered: boolean }> {
  if (passwordResetDevEchoEnabled()) {
    // Explicit developer opt-in only; unreachable when NODE_ENV === "production".
    console.info(
      `[password-reset][DEV ONLY] verification code for ${payload.to}: ${payload.code}`,
    );
  }
  const transport = await getTransport();
  if (!transport) return { delivered: false };
  try {
    await transport.sendMail({
      from: fromAddress(),
      to: payload.to,
      subject: "PNK Suguan — password reset verification code",
      text: body(payload),
    });
    return { delivered: true };
  } catch {
    // SMTP error detail can contain credentials/hostnames — log nothing of it.
    console.error("[password-reset] email delivery failed");
    return { delivered: false };
  }
}
