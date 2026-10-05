import { execFile } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { promisify } from "node:util";
import { z } from "zod";
import type { GrantedTool } from "../plugins/tools";

const execFileAsync = promisify(execFile);

/**
 * Google Workspace through the local `gog` CLI.
 *
 * No hosted OAuth, no key sync, no Composio round-trip: the machine holds its own Google
 * credentials (gog's keyring) and this module shells out to them. That keeps Google auth
 * local to the deployment — and means a deployment with
 * no Composio key at all still reads Gmail, Calendar and Drive.
 *
 * Offered only when the binary resolves (`GOG_BINARY`, else `gog` on PATH): a model offered
 * Google tools on a machine without the CLI spends attention on calls that fail as
 * configuration. Unauthenticated is a different state with its own sentence — the binary is
 * there, the person has not finished `gog auth`, and the fix is three commands, not a bug.
 */

export const GOG_TOOL_NAMES = [
  "gog_status",
  "gog_gmail_search",
  "gog_gmail_read",
  "gog_gmail_send",
  "gog_calendar_events",
  "gog_drive_search",
] as const;

/** The binary, or null when no Google CLI lives on this machine. Exported for tests. */
export function resolveGogBinary(
  environment: Record<string, string | undefined> = process.env,
): string | null {
  const configured = environment.GOG_BINARY?.trim();
  const candidates = configured
    ? [configured]
    : (environment.PATH ?? "")
        .split(":")
        .filter(Boolean)
        .map((dir) => `${dir}/gog`);
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not executable here; keep looking.
    }
  }
  return null;
}

async function runGog(
  binary: string,
  args: string[],
  timeoutMs = 60_000,
): Promise<{ ok: boolean; output: string }> {
  try {
    const { stdout } = await execFileAsync(binary, [...args, "--color=never"], {
      timeout: timeoutMs,
      maxBuffer: 2_000_000,
    });
    return { ok: true, output: stdout.trim() };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const stderr = (error as { stderr?: unknown }).stderr;
    const detail =
      typeof stderr === "string" && stderr.trim() ? stderr : message;
    if (/ENOENT|not found/i.test(`${message} ${detail}`)) {
      return {
        ok: false,
        output: `Google CLI binary not found at ${binary}. Install gogcli there or set GOG_BINARY to where it lives.`,
      };
    }
    return { ok: false, output: String(detail).slice(0, 2000) };
  }
}

function accountArgs(account?: string): string[] {
  return account?.trim() ? ["--account", account.trim()] : [];
}

export function gogToolsFor(options: { binary: string | null }): GrantedTool[] {
  const { binary } = options;

  const tool = (
    name: string,
    description: string,
    parameters: z.ZodType,
    execute: (args: Record<string, never>) => Promise<string>,
  ): GrantedTool => ({
    name,
    description,
    parameters,
    ref: `local/${name}`,
    /*
     * A mailbox and a Drive listing, which is the app class of answer rather than a screen one. The
     * bounds this selects live in `../plugins/result-budget`; what matters here is that `gog_gmail_search`
     * is capped by `max` and `gog_gmail_read` is not capped at all, so the result is whatever the
     * thread held, and a screen bound on it is what turned a 91-message thread into two entries.
     */
    resultBudget: "app",
    execute: async (args: unknown) =>
      execute((args ?? {}) as Record<string, never>),
  });

  // Without the binary every call fails as configuration, so the tools stay home and the
  // skill says how to install it instead.
  if (!binary) return [];

  const needsAuth = (output: string): boolean =>
    /not authenticated|no account|auth (required|missing|status)|credentials/i.test(
      output,
    );

  return [
    tool(
      "gog_status",
      "Whether this machine's Google CLI is installed and authenticated, and for which account. Call it before promising any Gmail, Calendar or Drive work.",
      z.object({}),
      async () => {
        const status = await runGog(
          binary,
          ["--json", "auth", "status"],
          20_000,
        );
        if (!status.ok)
          return `Google CLI is installed but unhealthy: ${status.output}`;
        try {
          const parsed = JSON.parse(status.output) as {
            account?: { email?: string };
            config?: { exists?: boolean };
          };
          const email = parsed.account?.email?.trim();
          return email
            ? `Google CLI is ready as ${email}.`
            : "Google CLI is installed but no account is authenticated. The person runs `gog auth add you@example.com --services gmail,drive,calendar,tasks --readonly` (least privilege first) on this machine, then this works.";
        } catch {
          return `Google CLI answered unexpectedly: ${status.output.slice(0, 500)}`;
        }
      },
    ),

    tool(
      "gog_gmail_search",
      "Search Gmail threads with Gmail query syntax (newer_than:7d, from:, subject:). Returns thread ids to read with gog_gmail_read.",
      z.object({
        query: z.string().describe("Gmail search query."),
        max: z.number().min(1).max(20).optional(),
        account: z.string().optional().describe("Account email or alias."),
      }),
      async (args) => {
        const a = args as { query?: unknown; max?: number; account?: string };
        const query = String(a.query ?? "").trim();
        if (!query) return "Say what to search Gmail for.";
        const result = await runGog(binary, [
          ...accountArgs(a.account),
          "gmail",
          "search",
          query,
          "--json",
          `--max=${Math.min(a.max ?? 10, 20)}`,
        ]);
        if (!result.ok) {
          return needsAuth(result.output)
            ? "Gmail is not authenticated on this machine. See gog_status for setup."
            : `Gmail search failed: ${result.output}`;
        }
        return result.output.slice(0, 6000) || "No matching threads.";
      },
    ),

    tool(
      "gog_gmail_read",
      "Read a Gmail thread with all its messages by thread id (from gog_gmail_search).",
      z.object({
        threadId: z.string().describe("The Gmail thread id."),
        account: z.string().optional(),
      }),
      async (args) => {
        const a = args as { threadId?: unknown; account?: string };
        const threadId = String(a.threadId ?? "").trim();
        if (!threadId) return "Say which thread to read.";
        const result = await runGog(binary, [
          ...accountArgs(a.account),
          "gmail",
          "thread",
          "get",
          threadId,
          "--json",
        ]);
        if (!result.ok) {
          return needsAuth(result.output)
            ? "Gmail is not authenticated on this machine. See gog_status for setup."
            : `Gmail read failed: ${result.output}`;
        }
        return result.output.slice(0, 8000);
      },
    ),

    tool(
      "gog_gmail_send",
      "Send an email through Gmail. External and half-baked sends are forbidden by the standing rules: confirm the recipient, subject and body with the person first unless they already dictated all three.",
      z.object({
        to: z.string().describe("Recipients, comma-separated."),
        subject: z.string(),
        body: z.string().describe("Plain-text body."),
        account: z.string().optional(),
      }),
      async (args) => {
        const a = args as {
          to?: unknown;
          subject?: unknown;
          body?: unknown;
          account?: string;
        };
        const to = String(a.to ?? "").trim();
        const subject = String(a.subject ?? "").trim();
        const body = String(a.body ?? "").trim();
        if (!to || !subject || !body) {
          return "Sending needs a recipient, a subject and a body.";
        }
        const result = await runGog(binary, [
          ...accountArgs(a.account),
          "gmail",
          "send",
          `--to=${to}`,
          `--subject=${subject}`,
          `--body=${body}`,
        ]);
        if (!result.ok) {
          return needsAuth(result.output)
            ? "Gmail is not authenticated on this machine. See gog_status for setup."
            : `Gmail send failed: ${result.output}`;
        }
        return result.output.slice(0, 1000) || "Sent.";
      },
    ),

    tool(
      "gog_calendar_events",
      "List upcoming calendar events across calendars, or on one calendar id.",
      z.object({
        calendarId: z
          .string()
          .optional()
          .describe("Calendar id. Defaults to primary."),
        max: z.number().min(1).max(30).optional(),
        account: z.string().optional(),
      }),
      async (args) => {
        const a = args as {
          calendarId?: unknown;
          max?: number;
          account?: string;
        };
        const result = await runGog(binary, [
          ...accountArgs(a.account),
          "calendar",
          "events",
          ...(typeof a.calendarId === "string" && a.calendarId.trim()
            ? [a.calendarId.trim()]
            : []),
          "--json",
          `--max=${Math.min(a.max ?? 10, 30)}`,
        ]);
        if (!result.ok) {
          return needsAuth(result.output)
            ? "Calendar is not authenticated on this machine. See gog_status for setup."
            : `Calendar read failed: ${result.output}`;
        }
        return result.output.slice(0, 6000) || "No upcoming events.";
      },
    ),

    tool(
      "gog_drive_search",
      "Full-text search across Google Drive. Returns file ids and names to read another way.",
      z.object({
        query: z.string().describe("Drive search query."),
        max: z.number().min(1).max(20).optional(),
        account: z.string().optional(),
      }),
      async (args) => {
        const a = args as { query?: unknown; max?: number; account?: string };
        const query = String(a.query ?? "").trim();
        if (!query) return "Say what to search Drive for.";
        const result = await runGog(binary, [
          ...accountArgs(a.account),
          "drive",
          "search",
          query,
          "--json",
          `--max=${Math.min(a.max ?? 10, 20)}`,
        ]);
        if (!result.ok) {
          return needsAuth(result.output)
            ? "Drive is not authenticated on this machine. See gog_status for setup."
            : `Drive search failed: ${result.output}`;
        }
        return result.output.slice(0, 6000) || "No matching files.";
      },
    ),
  ];
}
