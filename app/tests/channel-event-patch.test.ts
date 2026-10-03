import { describe, expect, test } from "bun:test";
import type { ChannelPage, ChannelSummary } from "../src/lib/channels/queries";
import {
  applyChannelEvent,
  type ChannelActivityEvent,
} from "../src/lib/channels/use-channel-events";

/** A minimal but fully-typed channel summary, so tests build real objects rather than casts. */
function channel(
  id: string,
  overrides: Partial<ChannelSummary> = {},
): ChannelSummary {
  return {
    id,
    name: id,
    agentIds: [],
    mascots: {},
    threadId: `thread-${id}`,
    active: true,
    summary: null,
    lastMessage: null,
    lastMessageAt: null,
    lastMessageAgentId: null,
    createdAt: "2024-01-01T00:00:00.000Z",
    pinned: false,
    lastReadAt: null,
    ...overrides,
  };
}

function cache(...pages: ChannelSummary[][]) {
  return {
    pages: pages.map(
      (channels): ChannelPage => ({ channels, nextCursor: null }),
    ),
    pageParams: pages.map(() => ""),
  };
}

function event(
  overrides: Partial<ChannelActivityEvent> & { channelId: string },
): ChannelActivityEvent {
  return {
    lastMessage: null,
    lastMessageAt: null,
    lastMessageAgentId: null,
    ...overrides,
  };
}

describe("an ordinary activity event", () => {
  test("patches the row inside the page that holds it and re-sorts that page", () => {
    const data = cache([
      channel("a", { lastMessageAt: "2024-03-01T00:00:00.000Z" }),
      channel("b"),
    ]);

    const patched = applyChannelEvent(
      data,
      event({
        channelId: "b",
        lastMessage: "Said something.",
        lastMessageAt: "2024-04-01T00:00:00.000Z",
      }),
    );

    expect(patched).not.toBe("unknown");
    if (patched === "unknown") return;
    expect(patched.pages[0]?.channels.map((row) => row.id)).toEqual(["b", "a"]);
    expect(patched.pages[0]?.channels[0]?.lastMessage).toBe("Said something.");
  });

  test("is unknown when no page holds the channel, so the caller refetches", () => {
    expect(
      applyChannelEvent(cache([channel("a")]), event({ channelId: "z" })),
    ).toBe("unknown");
  });
});

/**
 * A channel somebody deleted in another tab, or on another replica.
 *
 * The tab that issued the delete moves itself; every other tab only ever hears about it here, so
 * without this the row stays on their roster until something else makes them refetch.
 */
describe("a deleted channel", () => {
  test("is removed from the page that held it", () => {
    const data = cache([channel("a"), channel("b")], [channel("c")]);

    const patched = applyChannelEvent(
      data,
      event({ channelId: "b", deleted: true }),
    );

    expect(patched).not.toBe("unknown");
    if (patched === "unknown") return;
    expect(patched.pages[0]?.channels.map((row) => row.id)).toEqual(["a"]);
    // The other page is untouched, object identity included, so its rows do not re-render.
    expect(patched.pages[1]).toBe(data.pages[1]);
  });

  test("is never spread onto the row instead of removing it", () => {
    const patched = applyChannelEvent(
      cache([channel("a")]),
      event({ channelId: "a", deleted: true }),
    );

    expect(patched).not.toBe("unknown");
    if (patched === "unknown") return;
    // The failure this guards is a row left on the roster carrying `deleted: true`, which renders
    // as an ordinary channel whose every query now 404s.
    expect(patched.pages[0]?.channels).toEqual([]);
  });

  test("changes nothing when this cache never had the channel", () => {
    const data = cache([channel("a")]);

    // Unlike an ordinary event, an unknown id here is not a stale roster: the channel is already
    // gone from this cache, so there is nothing to patch and nothing to refetch for.
    expect(
      applyChannelEvent(data, event({ channelId: "z", deleted: true })),
    ).toBe(data);
  });
});

/**
 * A pin this person made in one of their own tabs.
 *
 * Scoped to them by the server, so arriving here means it is the reader's own pin.
 */
describe("a pin", () => {
  test("patches only the pinned flag, leaving the last message alone", () => {
    const data = cache([
      channel("a", {
        lastMessage: "Said something.",
        lastMessageAt: "2024-04-01T00:00:00.000Z",
        lastMessageAgentId: "agent-1",
      }),
    ]);

    const patched = applyChannelEvent(
      data,
      event({ channelId: "a", pinned: true }),
    );

    expect(patched).not.toBe("unknown");
    if (patched === "unknown") return;
    expect(patched.pages[0]?.channels[0]).toEqual({
      ...(data.pages[0]?.channels[0] as ChannelSummary),
      pinned: true,
    });
  });

  test("unpins the same way", () => {
    const patched = applyChannelEvent(
      cache([channel("a", { pinned: true })]),
      event({ channelId: "a", pinned: false }),
    );

    expect(patched).not.toBe("unknown");
    if (patched === "unknown") return;
    expect(patched.pages[0]?.channels[0]?.pinned).toBe(false);
  });

  test("returns the same cache when the row already says so", () => {
    const data = cache([channel("a", { pinned: true })]);

    // A duplicate, or the tab that made the pin hearing its own event back. Identity preserved, so
    // React re-renders nothing at all.
    expect(
      applyChannelEvent(data, event({ channelId: "a", pinned: true })),
    ).toBe(data);
  });
});

/**
 * A busy signal: a turn started or ended in the channel.
 *
 * Server-side headless work — a handoff hop, a relay — that no browser streamed, surfaced on the
 * roster as a working indicator. Message-less on purpose: it must not disturb the preview or the
 * order the way an ordinary activity event does.
 */
describe("a busy signal", () => {
  test("patches only the busy flag, leaving the last message and order alone", () => {
    const data = cache([
      channel("a", {
        lastMessage: "Said something.",
        lastMessageAt: "2024-04-01T00:00:00.000Z",
        lastMessageAgentId: "agent-1",
      }),
      channel("b", { lastMessageAt: "2024-05-01T00:00:00.000Z" }),
    ]);

    const patched = applyChannelEvent(
      data,
      event({ channelId: "a", busy: true }),
    );

    expect(patched).not.toBe("unknown");
    if (patched === "unknown") return;
    // Only `busy` changed on row a; its message survives, and b did not jump ahead of it.
    expect(patched.pages[0]?.channels.map((row) => row.id)).toEqual(["a", "b"]);
    expect(patched.pages[0]?.channels[0]).toEqual({
      ...(data.pages[0]?.channels[0] as ChannelSummary),
      busy: true,
    });
  });

  test("clears the same way", () => {
    const patched = applyChannelEvent(
      cache([channel("a", { busy: true })]),
      event({ channelId: "a", busy: false }),
    );

    expect(patched).not.toBe("unknown");
    if (patched === "unknown") return;
    expect(patched.pages[0]?.channels[0]?.busy).toBe(false);
  });

  test("returns the same cache when the row already says so", () => {
    const data = cache([channel("a", { busy: true })]);

    expect(applyChannelEvent(data, event({ channelId: "a", busy: true }))).toBe(
      data,
    );
  });
});

/**
 * A conversation the server has just named.
 *
 * Written by a sweep some seconds after the message that prompted it, so it arrives on its own long
 * after that message was announced.
 */
describe("a summary", () => {
  test("patches only the summary, leaving the last message alone", () => {
    const data = cache([
      channel("a", {
        lastMessage: "Said something.",
        lastMessageAt: "2024-04-01T00:00:00.000Z",
        lastMessageAgentId: "agent-1",
      }),
    ]);

    const patched = applyChannelEvent(
      data,
      event({ channelId: "a", summary: "Expense categories" }),
    );

    expect(patched).not.toBe("unknown");
    if (patched === "unknown") return;
    expect(patched.pages[0]?.channels[0]).toEqual({
      ...(data.pages[0]?.channels[0] as ChannelSummary),
      summary: "Expense categories",
    });
  });

  test("does not move the row it names", () => {
    // Naming a conversation is not something anybody said in it. A row that jumped to the top
    // seconds after the message that put it there would read as a second message arriving.
    const data = cache([
      channel("recent", { lastMessageAt: "2024-04-02T00:00:00.000Z" }),
      channel("older", { lastMessageAt: "2024-04-01T00:00:00.000Z" }),
    ]);

    const patched = applyChannelEvent(
      data,
      event({ channelId: "older", summary: "Something older" }),
    );

    expect(patched).not.toBe("unknown");
    if (patched === "unknown") return;
    expect(patched.pages[0]?.channels.map((row) => row.id)).toEqual([
      "recent",
      "older",
    ]);
  });

  test("returns the same cache when the row already says so", () => {
    const data = cache([channel("a", { summary: "Expense categories" })]);

    expect(
      applyChannelEvent(
        data,
        event({ channelId: "a", summary: "Expense categories" }),
      ),
    ).toBe(data);
  });
});

/*
 * RUN ACTIVITY ON THE ROSTER.
 *
 * The one behaviour that must not regress is the one the socket event exists for: a run ending has
 * to clear the mark. Everything else here is the ordinary patching rules applied to a new field.
 */
describe("applyChannelEvent for run activity", () => {
  const running = {
    state: "delegated" as const,
    label: "With Research Desk",
    detail: null,
    botId: "agent_a6d34c79",
  };

  test("a run starting puts a mark on the row", () => {
    const before = cache([channel("c1")]);
    const after = applyChannelEvent(before, {
      ...event({ channelId: "c1" }),
      activity: running,
    });
    expect(after).not.toBe("unknown");
    expect(
      (after as ReturnType<typeof cache>).pages[0].channels[0].activity,
    ).toEqual(running);
  });

  test("a run ending clears the mark, and clears it as null rather than leaving it stale", () => {
    const before = cache([channel("c1", { activity: running })]);
    const after = applyChannelEvent(before, {
      ...event({ channelId: "c1" }),
      activity: null,
    });
    const row = (after as ReturnType<typeof cache>).pages[0].channels[0];
    expect(row.activity).toBeNull();
  });

  test("an event with no activity key leaves the mark alone", () => {
    // The distinction the whole design turns on: absent means "this event is about something else",
    // null means "a run ended". Collapsing them strands the mark.
    const before = cache([channel("c1", { activity: running })]);
    const after = applyChannelEvent(before, {
      ...event({ channelId: "c1" }),
      busy: true,
    });
    expect(
      (after as ReturnType<typeof cache>).pages[0].channels[0].activity,
    ).toEqual(running);
  });

  test("a state arriving again unchanged changes nothing, so the roster does not re-render", () => {
    const before = cache([channel("c1", { activity: running })]);
    const after = applyChannelEvent(before, {
      ...event({ channelId: "c1" }),
      activity: { ...running },
    });
    // Identity, not equality: the caller re-renders nothing only if the cache object is the same one.
    expect(after).toBe(before);
  });

  test("a state change does not move the row to the top of the roster", () => {
    // A run starting is not something anybody said in the channel, and a roster that reorders
    // under the cursor while a Bot works is unusable.
    const older = channel("c1", {
      lastMessageAt: "2024-01-01T00:00:00.000Z",
      activity: null,
    });
    const newer = channel("c2", {
      lastMessageAt: "2024-06-01T00:00:00.000Z",
      activity: null,
    });
    const after = applyChannelEvent(cache([older, newer]), {
      ...event({ channelId: "c1" }),
      activity: running,
    });
    const rows = (after as ReturnType<typeof cache>).pages[0].channels;
    expect(rows.map((row) => row.id)).toEqual(["c1", "c2"]);
  });

  test("the preview survives a state change, which a spread would have wiped", () => {
    const before = cache([
      channel("c1", { lastMessage: "the quarterly numbers", activity: null }),
    ]);
    const after = applyChannelEvent(before, {
      ...event({ channelId: "c1" }),
      activity: running,
    });
    expect(
      (after as ReturnType<typeof cache>).pages[0].channels[0].lastMessage,
    ).toBe("the quarterly numbers");
  });
});
