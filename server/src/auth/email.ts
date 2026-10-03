import { isDisposableEmail } from "./disposable-email";

export type EmailServiceConfig = {
  provider: "resend" | "sendgrid";
  apiKey: string;
  from: string;
};

export type SendEmailInput = {
  to: string;
  subject: string;
  html: string;
  text?: string;
};

export class EmailDeliveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmailDeliveryError";
  }
}

/**
 * Parse an email "From" header string which may be either "Name <email@domain.com>" or "email@domain.com".
 */
export function parseFromHeader(from: string): {
  email: string;
  name?: string;
} {
  const match = from.match(/^(.*?)\s*<([^>]+)>$/);
  if (match) {
    const name = match[1]?.trim();
    const email = match[2]?.trim() ?? "";
    return name ? { email, name } : { email };
  }
  return { email: from.trim() };
}

/**
 * Send an email via Resend or SendGrid REST API.
 * In development, if no provider config is supplied, logs the action rather than failing.
 */
export async function sendEmail(
  config: EmailServiceConfig | undefined,
  input: SendEmailInput,
  fetchFn: typeof fetch = fetch,
): Promise<{ success: boolean; id?: string }> {
  const { to, subject, html, text } = input;

  if (isDisposableEmail(to)) {
    throw new EmailDeliveryError(
      "Temporary and disposable email addresses are not permitted.",
    );
  }

  if (!config) {
    // Development fallback when no email credentials are configured
    console.info(
      `[dev-email-simulation] To: ${to}\nSubject: ${subject}\n${text ?? html}`,
    );
    return { success: true, id: "dev-simulated" };
  }

  if (config.provider === "resend") {
    const response = await fetchFn("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: config.from,
        to: [to],
        subject,
        html,
        text,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new EmailDeliveryError(
        `Resend API error (${response.status}): ${errorText || response.statusText}`,
      );
    }

    const data = (await response.json().catch(() => ({}))) as { id?: string };
    return { success: true, id: data.id };
  }

  if (config.provider === "sendgrid") {
    const { email: fromEmail, name: fromName } = parseFromHeader(config.from);
    const content = [];
    if (text) content.push({ type: "text/plain", value: text });
    content.push({ type: "text/html", value: html });

    const response = await fetchFn("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: to }] }],
        from: { email: fromEmail, ...(fromName ? { name: fromName } : {}) },
        subject,
        content,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new EmailDeliveryError(
        `SendGrid API error (${response.status}): ${errorText || response.statusText}`,
      );
    }

    return { success: true };
  }

  throw new EmailDeliveryError(`Unsupported email provider`);
}

/**
 * Send a clean, responsive magic link email for passwordless sign-in.
 */
export async function sendMagicLinkEmail(
  config: EmailServiceConfig | undefined,
  { to, url }: { to: string; url: string },
  fetchFn?: typeof fetch,
): Promise<void> {
  const subject = "Sign in to Remii";
  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>${subject}</title>
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background-color: #f9fafb; margin: 0; padding: 40px 16px; color: #111827;">
  <div style="max-width: 440px; margin: 0 auto; background-color: #ffffff; border-radius: 12px; border: 1px solid #e5e7eb; padding: 32px; text-align: center; box-shadow: 0 1px 3px rgba(0,0,0,0.05);">
    <h2 style="font-size: 22px; font-weight: 600; margin-top: 0; margin-bottom: 12px; color: #111827;">Sign in to Remii</h2>
    <p style="font-size: 14px; line-height: 22px; color: #4b5563; margin-bottom: 24px;">
      Click the button below to complete your sign-in. This link will expire in 5 minutes.
    </p>
    <a href="${url}" target="_blank" style="display: inline-block; background-color: #18181b; color: #ffffff; font-size: 14px; font-weight: 500; text-decoration: none; padding: 12px 28px; border-radius: 8px; margin-bottom: 24px;">
      Sign in to Remii
    </a>
    <p style="font-size: 12px; line-height: 18px; color: #9ca3af; margin-bottom: 0;">
      If you did not request this email, you can safely ignore it.
    </p>
  </div>
</body>
</html>`;

  const text = `Sign in to Remii by visiting this link (expires in 5 minutes):\n\n${url}\n\nIf you did not request this email, you can safely ignore it.`;

  await sendEmail(config, { to, subject, html, text }, fetchFn);
}

/**
 * Send a clean verification code OTP email.
 */
export async function sendPasswordResetEmail(
  config: EmailServiceConfig | undefined,
  { to, url }: { to: string; url: string },
  fetchFn?: typeof fetch,
): Promise<void> {
  const subject = "Reset your Remii password";
  const html = `<p>Use the link below to reset your Remii password.</p><p><a href="${url}">Reset password</a></p><p>If you did not request this, you can ignore this email.</p>`;
  const text = `Reset your Remii password: ${url}\n\nIf you did not request this, you can ignore this email.`;
  await sendEmail(config, { to, subject, html, text }, fetchFn);
}

export async function sendVerificationOTPEmail(
  config: EmailServiceConfig | undefined,
  { to, otp }: { to: string; otp: string },
  fetchFn?: typeof fetch,
): Promise<void> {
  const subject = `${otp} is your Remii verification code`;
  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>${subject}</title>
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background-color: #f9fafb; margin: 0; padding: 40px 16px; color: #111827;">
  <div style="max-width: 440px; margin: 0 auto; background-color: #ffffff; border-radius: 12px; border: 1px solid #e5e7eb; padding: 32px; text-align: center; box-shadow: 0 1px 3px rgba(0,0,0,0.05);">
    <h2 style="font-size: 22px; font-weight: 600; margin-top: 0; margin-bottom: 12px; color: #111827;">Verification Code</h2>
    <p style="font-size: 14px; line-height: 22px; color: #4b5563; margin-bottom: 20px;">
      Enter the code below to verify your email address:
    </p>
    <div style="display: inline-block; background-color: #f3f4f6; border: 1px solid #e5e7eb; padding: 14px 24px; border-radius: 8px; font-size: 28px; font-weight: 700; letter-spacing: 6px; color: #111827; margin-bottom: 24px;">
      ${otp}
    </div>
    <p style="font-size: 12px; line-height: 18px; color: #9ca3af; margin-bottom: 0;">
      This code will expire in 5 minutes. If you did not request this code, you can safely ignore it.
    </p>
  </div>
</body>
</html>`;

  const text = `Your Remii verification code is: ${otp}\n\nThis code expires in 5 minutes. If you did not request this code, you can safely ignore it.`;

  await sendEmail(config, { to, subject, html, text }, fetchFn);
}
