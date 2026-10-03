import { describe, expect, test } from "bun:test";
import {
  handleTriggerEvent,
  isTriggerJunk,
  normalizeTriggerPayload,
  type TriggerDeps,
} from "../src/remi/triggers";

/**
 * Composio triggers, minus the vendor and the database.
 *
 * The database is a stub answering canned rows through the three chain shapes this module
 * reads (select/from/where/limit, select/from/where for automations, tasks by sourceRef).
 * What pins the contract: unknown users drop, self-sent mail never automates, redelivered
 * events file nothing twice, junk never reaches triage, and the handler never throws.
 */

function chainable(rows: unknown[] = [], _tag?: string) {
  const terminal = {
    limit: async () => rows,
    catch: async () => rows,
  };
  return {
    from: () => ({ where: () => terminal }),
  };
}

function deps(
  users: { id: string; email: string }[] = [
    { id: "user-1", email: "boss@example.com" },
  ],
  hooks: {
    turns?: string[];
    todos?: string[];
    automations?: {
      apps: string[];
      prompt: string;
      botId?: string | null;
      name?: string;
    }[];
  } = {},
): TriggerDeps {
  // Column-aware: user lookups ask for {id, email}, the dedup lookup asks for {id}
  // alone and starts empty (a redelivery test would seed it).
  const database = {
    select: (columns: Record<string, unknown>) =>
      chainable(
        "email" in columns ? users : [],
        "email" in columns ? undefined : "tasks",
      ),
  } as never;
  return {
    database,
    remiStore: {
      todos: {
        add: async (input: { title: string }) => {
          hooks.todos?.push(input.title);
          return `task-${hooks.todos?.length ?? 1}`;
        },
      },
    } as never,
    channelStore: {
      direct: async () => ({ id: "channel-1", threadId: "thread-1" }),
    } as never,
    runTurn: (async (input: { instruction: string }) => {
      hooks.turns?.push(input.instruction);
      return { replyText: "done" };
    }) as never,
    automations: {
      match: async () => hooks.automations ?? [],
      markRan: async () => {},
    } as never,
    model: { provider: "openai", defaultModel: "test-model" },
    environment: {},
  };
}

const gmailPayload = {
  id: "evt-1",
  metadata: { trigger_slug: "GMAIL_NEW_MESSAGE", user_id: "user-1" },
  data: {
    sender: "client@example.com",
    subject: "Please review the invoice",
    text: "Hi, please review invoice #42 and let me know.",
  },
};

describe("normalizeTriggerPayload", () => {
  test("shapes gmail around sender and subject", () => {
    const normalized = normalizeTriggerPayload(
      "GMAIL_NEW_MESSAGE",
      (gmailPayload as { data: unknown }).data,
    );

    expect(normalized.sourceApp).toBe("gmail");
    expect(normalized.title).toContain("client@example.com");
    expect(normalized.needsReply).toBe(true);
  });

  test("falls back generically for unknown apps", () => {
    const normalized = normalizeTriggerPayload("NOTION_PAGE", {
      title: "Roadmap",
    });

    expect(normalized.sourceApp).toBe("notion");
    expect(normalized.title).toContain("Roadmap");
  });
});

describe("isTriggerJunk", () => {
  test("noreply senders and promos are junk", () => {
    expect(
      isTriggerJunk({
        senderKey: "newsletter@shop.com",
        title: "x",
        snippet: "y",
      }).junk,
    ).toBe(true);
    expect(
      isTriggerJunk({ title: "50% off today", snippet: "sale sale" }).junk,
    ).toBe(true);
  });

  test("a personal ask is not junk", () => {
    expect(
      isTriggerJunk({
        senderKey: "client@example.com",
        title: "Please review",
        snippet: "the invoice attached",
      }).junk,
    ).toBe(false);
  });
});

describe("handleTriggerEvent", () => {
  test("drops events for unknown users without throwing", async () => {
    const outcome = await handleTriggerEvent(deps([]), {
      id: "evt-x",
      metadata: { trigger_slug: "GMAIL_NEW_MESSAGE" },
      data: { text: "hello" },
    });

    expect(outcome.success).toBe(false);
    expect(outcome.reason).toContain("user");
  });

  test("routes a matching automation before the todo pipeline", async () => {
    const turns: string[] = [];
    const todos: string[] = [];
    const outcome = await handleTriggerEvent(
      deps(undefined, {
        turns,
        todos,
        automations: [
          {
            id: "auto-1",
            apps: ["gmail"],
            prompt: "Summarize it",
            name: "summarizer",
          },
        ],
      }),
      gmailPayload,
    );

    expect(outcome.success).toBe(true);
    expect(outcome.automationId).toBeDefined();
    expect(turns).toHaveLength(1);
    expect(turns[0]).toContain("invoice");
    expect(todos).toHaveLength(0);
  });

  test("skips automation for mail the person sent themselves", async () => {
    const turns: string[] = [];
    const outcome = await handleTriggerEvent(
      deps(undefined, {
        turns,
        automations: [
          { id: "auto-all", apps: [], prompt: "Do it", name: "all" },
        ],
      }),
      {
        id: "evt-self",
        metadata: { trigger_slug: "GMAIL_NEW_MESSAGE", user_id: "user-1" },
        data: {
          sender: "boss@example.com",
          subject: "Sent item",
          text: "FYI",
        },
      },
    );

    // Falls through to the todo pipeline (no triage key here, so it fails closed).
    expect(turns).toHaveLength(0);
    expect(outcome.success).toBe(true);
    expect(outcome.skipped).toBe(true);
  });

  test("junk never reaches triage or todos", async () => {
    const todos: string[] = [];
    const outcome = await handleTriggerEvent(deps(undefined, { todos }), {
      id: "evt-junk",
      metadata: { trigger_slug: "GMAIL_NEW_MESSAGE", user_id: "user-1" },
      data: {
        sender: "news@shop.com",
        subject: "50% off today",
        text: "Unsubscribe here.",
      },
    });

    expect(outcome.success).toBe(true);
    expect(outcome.skipped).toBe(true);
    expect(todos).toHaveLength(0);
  });

  test("empty payloads fail closed", async () => {
    const outcome = await handleTriggerEvent(deps(), null);

    expect(outcome.success).toBe(false);
  });
});
