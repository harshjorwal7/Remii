import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { REMII_AGENT_ID } from "../../../shared/remii";
import type { AgentActor } from "../agents/profile-types";
import type { AuditStore } from "../audit";
import { recordAuditEvent } from "../audit";
import type { ChannelStore } from "../channels/routes";
import type { Database } from "../db/client";
import {
  automations,
  composioConnections,
  tasks,
  telegramLinks,
  users,
} from "../db/schema";
import type { TurnRunner } from "../routines/runner";
import { buildModelChain } from "./model-router";
import type { createRemiStore } from "./store";

/**
 * Composio trigger events → automations or todos, ported from Remi.
 *
 * A vendor webhook says something happened in somebody's connected app. This resolves WHO
 * (metadata user id, then the local connected-account row, then payload email heuristics —
 * strictly deployment-local, never a hardcoded whitelist), checks their automations first
 * (an enabled automation naming the app fires its prompt as a turn run as the owner, with a
 * reply-loop guard skipping events the person's own account sent), and otherwise files a
 * todo through the junk filter and a model triage. Event ids deduplicate on the todo's
 * source ref, so a redelivered webhook files nothing twice.
 *
 * Never throws: a webhook that fails loudly gets retried loudly by the vendor, and a poison
 * payload would retry forever. Every outcome is a returned reason instead.
 */

export type NormalizedTrigger = {
  title: string;
  snippet: string;
  sourceApp: string;
  senderKey: string | null;
  tags: string[];
  importance: "HIGH" | "MEDIUM" | "LOW";
  needsReply: boolean;
};

export function normalizeTriggerPayload(
  slug: string,
  data: unknown,
): NormalizedTrigger {
  const upperSlug = (slug ?? "").toUpperCase();
  const record = (data ?? {}) as Record<string, unknown>;
  const str = (value: unknown, fallback = ""): string =>
    typeof value === "string" ? value : fallback;

  if (
    upperSlug.includes("GMAIL") ||
    upperSlug.includes("OUTLOOK") ||
    upperSlug.includes("MAIL")
  ) {
    const sender = str(
      record.sender ?? record.from ?? record.from_email,
      "Unknown Sender",
    );
    const subject = str(record.subject ?? record.thread_subject, "No Subject");
    const parts = (record.parts ??
      (record.payload as { parts?: unknown[] } | undefined)?.parts) as
      | { mimeType?: string; body?: { data?: string } }[]
      | undefined;
    let body = str(record.text ?? record.body);
    if (!body && Array.isArray(parts)) {
      for (const part of parts) {
        if (
          (part?.mimeType ?? "").toLowerCase() === "text/plain" &&
          part?.body?.data
        ) {
          try {
            body = Buffer.from(part.body.data, "base64").toString("utf-8");
            break;
          } catch {
            // A part that is not base64 is skipped, not fatal.
          }
        }
      }
      if (!body) {
        for (const part of parts) {
          if (part?.body?.data) {
            try {
              body = Buffer.from(part.body.data, "base64").toString("utf-8");
              break;
            } catch {
              // As above.
            }
          }
        }
      }
    }
    if (!body)
      body = str(
        record.snippet ??
          (record.preview as { body?: string } | undefined)?.body,
      );
    const urgent =
      /urgent|asap|important|action required|invoice|deadline/i.test(
        `${subject} ${body}`,
      );
    return {
      title: `Email from ${sender}: ${subject}`,
      snippet: body,
      sourceApp: upperSlug.includes("OUTLOOK") ? "outlook" : "gmail",
      senderKey: sender,
      tags: ["email", upperSlug.includes("OUTLOOK") ? "outlook" : "gmail"],
      importance: urgent ? "HIGH" : "MEDIUM",
      needsReply: true,
    };
  }

  if (upperSlug.includes("SLACK")) {
    const channel = str(record.channel_name ?? record.channel, "chat");
    const user = str(record.user_name ?? record.user, "User");
    const text = str(record.text ?? record.message);
    return {
      title: `Slack message in #${channel} from ${user}`,
      snippet: text,
      sourceApp: "slack",
      senderKey: user,
      tags: ["slack", "chat"],
      importance: text.toLowerCase().includes("urgent") ? "HIGH" : "MEDIUM",
      needsReply: text.includes("@") || text.toLowerCase().includes("please"),
    };
  }

  if (upperSlug.includes("GITHUB")) {
    const action = record.action ? ` (${String(record.action)})` : "";
    const pr = record.pull_request as
      | { title?: string; body?: string }
      | undefined;
    const issue = record.issue as { title?: string; body?: string } | undefined;
    const comment = record.comment as { body?: string } | undefined;
    const titleText = str(
      pr?.title ?? issue?.title ?? record.title ?? record.message,
      "GitHub Event",
    );
    const body = str(pr?.body ?? issue?.body ?? comment?.body ?? record.body);
    const sender = ((record.sender as { login?: string } | undefined)?.login ??
      (pr as { user?: { login?: string } } | undefined)?.user?.login ??
      (typeof record.author === "string" ? record.author : null)) as
      | string
      | null;
    return {
      title: `GitHub${action}: ${titleText}`,
      snippet: body,
      sourceApp: "github",
      senderKey: sender,
      tags: ["github", "dev"],
      importance: "MEDIUM",
      needsReply: false,
    };
  }

  if (upperSlug.includes("LINKEDIN")) {
    const sender = str(record.sender_name ?? record.sender, "LinkedIn User");
    const text = str(record.message ?? record.text ?? record.comment);
    return {
      title: `LinkedIn DM from ${sender}`,
      snippet: text,
      sourceApp: "linkedin",
      senderKey: sender,
      tags: ["linkedin", "social"],
      importance: "HIGH",
      needsReply: true,
    };
  }

  if (upperSlug.includes("FIGMA")) {
    const file = str(record.file_name ?? record.file_key, "Design");
    const triggered = record.triggered_by as { handle?: string } | undefined;
    const author = str(triggered?.handle ?? record.author, "Teammate");
    const comment = (record.comment as { text?: string }[] | undefined)?.[0]
      ?.text;
    const text = str(comment ?? record.message);
    return {
      title: `Figma comment on "${file}" by ${author}`,
      snippet: text,
      sourceApp: "figma",
      senderKey: author,
      tags: ["figma", "design"],
      importance: "MEDIUM",
      needsReply: true,
    };
  }

  const appName = upperSlug.split("_")[0]?.toLowerCase() ?? "webhook";
  return {
    title: `${appName.toUpperCase()}: ${str(record.title ?? record.subject ?? record.name ?? `${slug} Event`)}`,
    snippet: str(
      record.snippet ??
        record.text ??
        record.message ??
        record.description ??
        (typeof data === "object"
          ? JSON.stringify(data).slice(0, 300)
          : String(data)),
    ),
    sourceApp: appName,
    senderKey:
      typeof record.sender === "string"
        ? record.sender
        : typeof record.author === "string"
          ? record.author
          : typeof record.from === "string"
            ? record.from
            : null,
    tags: [appName],
    importance: "MEDIUM",
    needsReply: false,
  };
}

const AUTOMATED_SENDER_RE =
  /(?:^|[@+.<\s])(no-?reply|donotreply|do-not-reply|mailer-daemon|notifications?|newsletter|marketing|noreply)(?:@|[.\s>]|$)/i;

const BODY_JUNK_PATTERNS: { re: RegExp; reason: string }[] = [
  { re: /\bunsubscribe\b/i, reason: "unsubscribe" },
  { re: /\bview in (?:browser|app)\b/i, reason: "view_in_browser" },
  { re: /\bemail preferences\b/i, reason: "email_preferences" },
  { re: /\b\d{1,3}%\s*off\b/i, reason: "promo_percent_off" },
  { re: /\b(?:weekly|daily|monthly)\s+digest\b/i, reason: "digest" },
  {
    re: /\byou(?:'re| are) receiving this (?:email )?because\b/i,
    reason: "bulk_disclaimer",
  },
  { re: /\bone[- ]time (?:pass)?(?:word|code|password)\b/i, reason: "otp" },
  { re: /\bverification code\b/i, reason: "verification_code" },
  { re: /\bpassword reset\b/i, reason: "password_reset" },
  { re: /\b(?:2fa|two[- ]factor)\b/i, reason: "2fa" },
  { re: /\blogin alert\b/i, reason: "login_alert" },
  { re: /\bsecurity code\b/i, reason: "security_code" },
  { re: /\bviewed your profile\b/i, reason: "profile_view" },
  { re: /\bconnection request\b/i, reason: "connection_request" },
  { re: /\bpeople you may know\b/i, reason: "people_you_may_know" },
];

/** Cheap pre-model filter for newsletters, marketing, OTP and bots. */
export function isTriggerJunk(input: {
  title?: string;
  snippet?: string;
  senderKey?: string | null;
}): { junk: boolean; reason?: string } {
  const sender = (input.senderKey ?? "").trim();
  if (sender && AUTOMATED_SENDER_RE.test(sender)) {
    return { junk: true, reason: "hard_rule:noreply_sender" };
  }
  const haystack = `${input.title ?? ""}\n${input.snippet ?? ""}`;
  for (const { re, reason } of BODY_JUNK_PATTERNS) {
    if (re.test(haystack)) return { junk: true, reason: `hard_rule:${reason}` };
  }
  const title = (input.title ?? "").trim();
  const snippet = (input.snippet ?? "").trim();
  if (
    title.length > 0 &&
    snippet.length < 20 &&
    /\b(?:sale|deal|offer|newsletter|promo|discount)\b/i.test(title)
  ) {
    return { junk: true, reason: "hard_rule:promo_thin_body" };
  }
  return { junk: false };
}

export type TriggerTriage = {
  actionable: boolean;
  reason: string;
  title: string;
  snippet: string;
  tags: string[];
  importance: "HIGH" | "MEDIUM" | "LOW";
  needsReply: boolean;
};

/**
 * Decide with a cheap model call whether an event deserves a todo. Fails closed: no key,
 * no parse, no answer all mean no todo, because a trigger pipeline that files on doubt
 * files forever.
 */
export async function triageTriggerEvent(input: {
  triggerSlug: string;
  rawPayload: unknown;
  normalized: NormalizedTrigger;
  model: { provider: "openai"; model: string };
  environment?: Record<string, string | undefined>;
}): Promise<TriggerTriage> {
  const failClosed = (reason: string): TriggerTriage => ({
    actionable: false,
    reason,
    title: input.normalized.title.slice(0, 255),
    snippet: input.normalized.snippet.slice(0, 2000),
    tags: input.normalized.tags,
    importance: input.normalized.importance,
    needsReply: false,
  });
  // Triage spends the deployment's own explicit key, not a fallback: filing todos is a
  // decision, and a decision made by whichever provider happened to be up is not one.
  const key =
    (input.environment ?? process.env).OPENAI_API_KEY ??
    (input.environment ?? process.env).DEEPSEEK_API_KEY ??
    null;
  const keyed = key
    ? buildModelChain(input.model, input.environment ?? process.env, key)
    : [];
  if (keyed.length === 0) return failClosed("triage:no_api_key");

  try {
    // Non-empty by construction: the guard above is `keyed.length === 0`.
    const link = keyed[0];
    if (!link) throw new Error("a key was matched and no link was built for it");
    const completion = await link.client.chat.completions.create(
      {
        model: link.model,
        messages: [
          {
            role: "system",
            content: `You are Remii's triage assistant. Decide if this ${input.triggerSlug} notification should become a personal to-do for the user.

KEEP (actionable=true) only if the user personally must decide, reply, or do something: someone asked them a question or work, a commitment, meeting conflict, invoice to pay, human review request.
DROP (actionable=false) for newsletters, marketing, automated notifications with no human action, OTP/login/2FA, CI/bots, social vanity, FYI-only noise. When unsure, DROP.

Return ONLY a JSON object: {"actionable":boolean,"reason":string,"title":string (max 120 chars),"snippet":string (max 500),"tags":[1-3 lowercase],"importance":"HIGH"|"MEDIUM"|"LOW","needsReply":boolean,"senderKey":string|null}. No markdown, no commentary.`,
          },
          {
            role: "user",
            content: JSON.stringify({
              title: input.normalized.title,
              snippet: input.normalized.snippet.slice(0, 800),
              sender: input.normalized.senderKey,
              sourceApp: input.normalized.sourceApp,
              raw: JSON.stringify(input.rawPayload).slice(0, 3000),
            }),
          },
        ],
        temperature: 0.2,
        max_tokens: 600,
        ...(link.extraBody ?? {}),
      },
      { timeout: 60_000 },
    );
    const text = (completion.choices?.[0]?.message?.content ?? "")
      .trim()
      .replace(/^```json\s*/i, "")
      .replace(/```$/, "")
      .trim();
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (typeof parsed.actionable !== "boolean") {
      return failClosed("triage:invalid_actionable");
    }
    const importance =
      parsed.importance === "HIGH" ||
      parsed.importance === "MEDIUM" ||
      parsed.importance === "LOW"
        ? parsed.importance
        : input.normalized.importance;
    return {
      actionable: parsed.actionable,
      reason: String(parsed.reason ?? "model"),
      title:
        String(parsed.title ?? input.normalized.title).slice(0, 255) ||
        input.normalized.title,
      snippet: String(parsed.snippet ?? input.normalized.snippet).slice(
        0,
        2000,
      ),
      tags: Array.isArray(parsed.tags)
        ? parsed.tags
            .filter((tag): tag is string => typeof tag === "string")
            .slice(0, 3)
        : input.normalized.tags,
      importance,
      needsReply: parsed.needsReply === true,
    };
  } catch {
    return failClosed("triage:failed");
  }
}

export type Automation = {
  id: string;
  userId: string;
  botId: string | null;
  name: string;
  apps: string[];
  prompt: string;
  enabled: boolean;
};

export function createAutomationStore(database: Database) {
  return {
    async list(userId: string): Promise<Automation[]> {
      return database
        .select()
        .from(automations)
        .where(eq(automations.userId, userId));
    },
    async create(input: {
      userId: string;
      botId?: string;
      name: string;
      apps?: string[];
      prompt: string;
    }): Promise<Automation> {
      const [row] = await database
        .insert(automations)
        .values({
          id: randomUUID(),
          userId: input.userId,
          botId: input.botId ?? null,
          name: input.name.trim(),
          apps: (input.apps ?? []).map((app) => app.toLowerCase()),
          prompt: input.prompt,
          enabled: true,
        })
        .returning();
      if (!row) throw new Error("Automation could not be created.");
      return row as Automation;
    },
    async update(
      userId: string,
      id: string,
      patch: {
        name?: string;
        apps?: string[];
        prompt?: string;
        enabled?: boolean;
      },
    ): Promise<boolean> {
      const set: Record<string, unknown> = { updatedAt: new Date() };
      if (patch.name !== undefined) set.name = patch.name.trim();
      if (patch.apps !== undefined) {
        set.apps = patch.apps.map((app) => app.toLowerCase());
      }
      if (patch.prompt !== undefined) set.prompt = patch.prompt;
      if (patch.enabled !== undefined) set.enabled = patch.enabled;
      const rows = await database
        .update(automations)
        .set(set)
        .where(and(eq(automations.id, id), eq(automations.userId, userId)))
        .returning({ id: automations.id });
      return rows.length > 0;
    },
    async remove(userId: string, id: string): Promise<boolean> {
      const rows = await database
        .delete(automations)
        .where(and(eq(automations.id, id), eq(automations.userId, userId)))
        .returning({ id: automations.id });
      return rows.length > 0;
    },
    async match(userId: string, sourceApp: string): Promise<Automation[]> {
      const rows = await database
        .select()
        .from(automations)
        .where(
          and(eq(automations.userId, userId), eq(automations.enabled, true)),
        );
      const app = sourceApp.toLowerCase();
      return (rows as Automation[]).filter(
        (row) => row.apps.length === 0 || row.apps.includes(app),
      );
    },
    async markRan(id: string, error?: string): Promise<void> {
      await database
        .update(automations)
        .set({
          lastRunAt: new Date(),
          ...(error ? { lastError: error.slice(0, 500) } : { lastError: null }),
        })
        .where(eq(automations.id, id))
        .catch(() => undefined);
    },
  };
}

export type AutomationStore = ReturnType<typeof createAutomationStore>;

export type TriggerDeps = {
  database: Database;
  remiStore: ReturnType<typeof createRemiStore>;
  channelStore: ChannelStore;
  runTurn: TurnRunner;
  automations: AutomationStore;
  audit?: AuditStore;
  model: { provider: "openai"; model: string };
  environment?: Record<string, string | undefined>;
  defaultBotId?: string;
  by?: string;
  /** Telegram bot token: filed todos also notify the linked chat when there is one. */
  telegramBotToken?: string;
};

export type TriggerOutcome = {
  success: boolean;
  reason?: string;
  automationId?: string;
  taskId?: string;
  duplicate?: boolean;
  skipped?: boolean;
  suppressed?: boolean;
};

export async function handleTriggerEvent(
  deps: TriggerDeps,
  payload: unknown,
): Promise<TriggerOutcome> {
  const { database } = deps;
  if (!payload || typeof payload !== "object") {
    return { success: false, reason: "empty payload" };
  }
  const body = payload as Record<string, unknown>;
  const metadata = (body.metadata ?? {}) as Record<string, unknown>;
  const eventId = (body.id ?? body.event_id ?? metadata.event_id) as
    | string
    | undefined;
  const triggerSlug = String(
    metadata.trigger_slug ?? body.type ?? "UNKNOWN_TRIGGER",
  );
  const data = (body.data ?? body.payload ?? body) as Record<string, unknown>;
  const connectedAccountId = metadata.connected_account_id as
    | string
    | undefined;
  const sourceRef = eventId ? `composio:${eventId}` : `composio:${Date.now()}`;

  // WHO: metadata user id, then the local connected-account row. Strict
  // per-user SaaS sandbox: never attribute by payload email addresses. A
  // forged "to"/"from" would file todos and run automations as the victim,
  // so an event that names no resolvable local user is dropped, not guessed.
  // When both signals are present they must agree on one user; a mismatch is
  // a spoof attempt and is dropped too.
  let userId: string | null = null;
  let userEmail = "";
  let metadataUserId: string | null = null;
  if (typeof metadata.user_id === "string" && metadata.user_id) {
    const [row] = await database
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(eq(users.id, metadata.user_id))
      .limit(1)
      .catch(() => []);
    if (row) {
      metadataUserId = row.id;
      userId = row.id;
      userEmail = row.email;
    }
  }
  if (connectedAccountId) {
    const [row] = await database
      .select({ userId: composioConnections.userId })
      .from(composioConnections)
      .where(eq(composioConnections.accountId, connectedAccountId))
      .limit(1)
      .catch(() => []);
    if (row) {
      if (metadataUserId && row.userId !== metadataUserId) {
        return { success: false, reason: "user mismatch for this event" };
      }
      const [user] = await database
        .select({ id: users.id, email: users.email })
        .from(users)
        .where(eq(users.id, row.userId))
        .limit(1)
        .catch(() => []);
      if (user) {
        userId = user.id;
        userEmail = user.email;
      }
    } else if (!metadataUserId) {
      return { success: false, reason: "user not found for this event" };
    }
  }
  if (!userId) {
    return { success: false, reason: "user not found for this event" };
  }

  const normalized = normalizeTriggerPayload(triggerSlug, data);

  // Automations first: user-defined routing always beats the todo pipeline.
  const ownEmail = userEmail.toLowerCase();
  const senderKey = normalized.senderKey?.toLowerCase() ?? "";
  const selfSent =
    !!ownEmail &&
    (senderKey === ownEmail || senderKey.includes(`<${ownEmail}>`));
  if (!selfSent) {
    const matched = await deps.automations
      .match(userId, normalized.sourceApp)
      .catch(() => []);
    if (matched.length > 0) {
      // Non-empty by construction: the guard above is `matched.length > 0`.
      const automation = matched[0];
      if (!automation) throw new Error("match() reported an automation and returned none");
      const actor: AgentActor = { id: userId, role: "user" };
      try {
        const channel = await deps.channelStore.direct(
          actor,
          automation.botId ?? deps.defaultBotId ?? REMII_AGENT_ID,
        );
        await deps.runTurn({
          ownerUserId: userId,
          routineId: `automation:${automation.id}`,
          agentId: automation.botId ?? deps.defaultBotId ?? REMII_AGENT_ID,
          threadId: channel.threadId,
          instruction: `[Trigger: ${normalized.sourceApp}] ${normalized.title}\n\n${normalized.snippet}\n\nAutomation "${automation.name}": ${automation.prompt}`,
        });
        await deps.automations.markRan(automation.id);
      } catch (error) {
        await deps.automations.markRan(
          automation.id,
          error instanceof Error ? error.message : String(error),
        );
        return { success: false, reason: "automation run failed" };
      }
      return { success: true, automationId: automation.id };
    }
  }

  // Idempotency on the event: a redelivered webhook files nothing twice.
  const [existing] = await database
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(eq(tasks.userId, userId), eq(tasks.sourceRef, sourceRef)))
    .limit(1)
    .catch(() => []);
  if (existing) {
    return { success: true, duplicate: true, taskId: existing.id };
  }

  const junk = isTriggerJunk({
    title: normalized.title,
    snippet: normalized.snippet,
    senderKey: normalized.senderKey,
  });
  if (junk.junk) {
    return { success: true, skipped: true, reason: junk.reason ?? "hard_rule" };
  }

  const triage = await triageTriggerEvent({
    triggerSlug,
    rawPayload: data,
    normalized,
    model: deps.model,
    environment: deps.environment,
  });
  if (!triage.actionable) {
    return { success: true, skipped: true, reason: `triage:${triage.reason}` };
  }

  const taskId = await deps.remiStore.todos
    .add({
      userId,
      title: triage.title,
      rawSnippet: triage.snippet,
      sourceApp: normalized.sourceApp,
      sourceAccount:
        typeof metadata.connected_account_id === "string"
          ? metadata.connected_account_id
          : normalized.sourceApp,
      senderKey: normalized.senderKey ?? undefined,
      sourceRef,
      importance: triage.importance,
      createdVia: "COMPOSIO_TRIGGER",
      tags: triage.tags,
    })
    .catch(() => null);
  if (!taskId) {
    return { success: false, reason: "todo could not be filed" };
  }
  if (deps.audit) {
    await recordAuditEvent(deps.audit, {
      eventType: "configuration.changed",
      targetType: "task",
      targetId: taskId,
      actorUserId: userId,
      payload: {
        actor: deps.by ?? userId,
        change: "trigger_todo_filed",
        sourceApp: normalized.sourceApp,
        trigger: triggerSlug,
      },
    }).catch(() => undefined);
  }
  if (deps.telegramBotToken) {
    // Best effort: the todo is filed either way, and a chat that was never linked gets
    // nothing rather than an error.
    const [link] = await database
      .select({ chatId: telegramLinks.chatId })
      .from(telegramLinks)
      .where(eq(telegramLinks.userId, userId))
      .limit(1)
      .catch(() => []);
    if (link?.chatId) {
      const emoji =
        normalized.sourceApp === "gmail" || normalized.sourceApp === "outlook"
          ? "📧"
          : normalized.sourceApp === "slack"
            ? "💬"
            : normalized.sourceApp === "github"
              ? "🐙"
              : "🔔";
      await fetch(
        `https://api.telegram.org/bot${deps.telegramBotToken}/sendMessage`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            chat_id: link.chatId,
            text: `${emoji} ${triage.title}\n${triage.snippet.slice(0, 500)}`,
          }),
          signal: AbortSignal.timeout(20_000),
        },
      ).catch(() => undefined);
    }
  }
  return { success: true, taskId };
}

/** The `automations` tool schemas, shared by the tool below and its tests. */
export const automationAction = z.enum(["create", "list", "update", "delete"]);
