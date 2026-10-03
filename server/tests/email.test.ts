import { describe, expect, test } from "bun:test";
import {
  EmailDeliveryError,
  parseFromHeader,
  sendEmail,
  sendMagicLinkEmail,
} from "../src/auth/email";

describe("parseFromHeader", () => {
  test("parses standard 'Name <email@domain.com>' format", () => {
    expect(parseFromHeader("Remii <auth@remii.app>")).toEqual({
      name: "Remii",
      email: "auth@remii.app",
    });
  });

  test("parses bare email address", () => {
    expect(parseFromHeader("auth@remii.app")).toEqual({
      email: "auth@remii.app",
    });
  });
});

describe("sendEmail with Resend", () => {
  test("formats POST payload correctly for Resend", async () => {
    let calledUrl = "";
    let calledOptions: RequestInit | undefined;

    const mockFetch = async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      calledUrl = String(input);
      calledOptions = init;
      return new Response(JSON.stringify({ id: "resend_123" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    const result = await sendEmail(
      {
        provider: "resend",
        apiKey: "re_test_key",
        from: "Remii <auth@remii.app>",
      },
      {
        to: "user@example.com",
        subject: "Hello from Remii",
        html: "<p>Welcome</p>",
        text: "Welcome",
      },
      mockFetch as typeof fetch,
    );

    expect(result).toEqual({ success: true, id: "resend_123" });
    expect(calledUrl).toBe("https://api.resend.com/emails");
    expect(calledOptions?.method).toBe("POST");
    expect(
      (calledOptions?.headers as Record<string, string>)?.Authorization,
    ).toBe("Bearer re_test_key");

    const body = JSON.parse(calledOptions?.body as string);
    expect(body.from).toBe("Remii <auth@remii.app>");
    expect(body.to).toEqual(["user@example.com"]);
    expect(body.subject).toBe("Hello from Remii");
  });
});

describe("sendEmail with SendGrid", () => {
  test("formats POST payload correctly for SendGrid", async () => {
    let calledUrl = "";
    let calledOptions: RequestInit | undefined;

    const mockFetch = async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      calledUrl = String(input);
      calledOptions = init;
      return new Response("", { status: 202 });
    };

    const result = await sendEmail(
      {
        provider: "sendgrid",
        apiKey: "SG.test_key",
        from: "Remii <auth@remii.app>",
      },
      {
        to: "user@example.com",
        subject: "Verify your email",
        html: "<p>Code: 123456</p>",
      },
      mockFetch as typeof fetch,
    );

    expect(result).toEqual({ success: true });
    expect(calledUrl).toBe("https://api.sendgrid.com/v3/mail/send");
    expect(calledOptions?.method).toBe("POST");
    expect(
      (calledOptions?.headers as Record<string, string>)?.Authorization,
    ).toBe("Bearer SG.test_key");

    const body = JSON.parse(calledOptions?.body as string);
    expect(body.from).toEqual({ email: "auth@remii.app", name: "Remii" });
    expect(body.personalizations).toEqual([
      { to: [{ email: "user@example.com" }] },
    ]);
  });
});

describe("abuse prevention in email delivery", () => {
  test("rejects sending to disposable email domains", async () => {
    expect(
      sendEmail(
        {
          provider: "resend",
          apiKey: "re_test_key",
          from: "Remii <auth@remii.app>",
        },
        {
          to: "bot@mailinator.com",
          subject: "Test",
          html: "<p>Test</p>",
        },
      ),
    ).rejects.toThrow(EmailDeliveryError);

    expect(
      sendMagicLinkEmail(undefined, {
        to: "scam@guerrillamail.com",
        url: "https://remii.app/magic-link",
      }),
    ).rejects.toThrow(/disposable/);
  });
});
