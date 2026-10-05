import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { loadConfig } from "../src/config";
import { users } from "../src/db/schema";
import { threadMessages, threads } from "../src/db/schema/threads";
import { createApp } from "../src/app";
import { createThreadStore } from "../src/threads/local";
import { testEnvironment } from "./support/environment";
import { testDatabase } from "./support/database";
import type { AppVariables } from "../src/auth/guards";

/**
 * A DELEGATED CONVERSATION CAN BE READ BY THE PERSON IT WAS DELEGATED TO.
 *
 * This is the complaint, written down as a test because it was not caught by any other one: a
 * person asked Remii to send an email, Remii handed the work to Coco, Coco did it and asked the
 * person a question, and the person saw nothing at all. The work completed. The draft was written.
 * The question existed. None of it was readable.
 *
 * There were three separate causes and each is exercised here, because fixing one of them still
 * leaves a person unable to read their own conversation:
 *
 *   1. the hop ran in a thread named after a channel, so the messages were somewhere no screen
 *      reads (`agents/own-channel.ts`);
 *   2. the thread row had no owner, so the transcript route's ownership join excluded every one of
 *      them (`threads/local.ts` and `channels/routes.ts` — twelve conversations on this deployment
 *      were in exactly that state);
 *   3. the attribution named a bot id instead of the person who works with it
 *      (`agents/handoff-runner.ts`).
 *
 * The route is the real one, reached through `createApp`, because the join that hid these messages
 * lives in the route and a test of the store alone would have passed while every one of them stayed
 * invisible.
 */

const database = testDatabase();
const threadStore = createThreadStore(database);
const OWNER = "deleg-read-owner";
const STRANGER = "deleg-read-stranger";
const createdThreadIds: string[] = [];
const _createdChannelIds: string[] = [];

const config = loadConfig(
  testEnvironment({ AGENT_TOOL_TOKEN: "deleg-read-token" }),
);

beforeEach(async () => {
  for (const id of [OWNER, STRANGER]) {
    await database
      .insert(users)
      .values({ id, email: `${id}-${randomUUID()}@example.test` })
      .onConflictDoNothing();
  }
});

afterEach(async () => {
  for (const id of createdThreadIds.splice(0)) {
    await database.delete(threads).where(eq(threads.id, id));
    await database
      .delete(threadMessages)
      .where(eq(threadMessages.threadId, id));
  }
  await database
    .delete(users)
    .where(eq(users.id, OWNER))
    .catch(() => undefined);
  await database
    .delete(users)
    .where(eq(users.id, STRANGER))
    .catch(() => undefined);
});

/**
 * The app with the transcript route mounted, signed in as one person.
 *
 * WRITTEN AS INDEXED SLOTS rather than as twenty-odd literal `undefined`s, because `createApp` takes
 * thirty-four positional arguments and a count that is off by one produces a green test of nothing.
 * Two attempts at this file passed every assertion with the database in the wrong slot: the route
 * answered from a different database, so "no messages" was true and the assertions were satisfied
 * for the wrong reason. The index below IS the position, and `attachmentDatabase` is 24.
 */
function appAs(userId: string) {
  /*
   * A real session, so the deployment's OWN `requireUser` decides who is asking. Stubbing the guard
   * would test the route without the thing that routes it, and the ownership join this file exists to
   * cover sits on the other side of that guard.
   */
  const auth = {
    handler: () => new Response(null, { status: 204 }),
    api: {
      getSession: async () => ({
        user: {
          id: userId,
          email: `${userId}@example.test`,
          name: userId,
          image: "",
        },
      }),
    },
  };

  const copilot = new Hono();
  copilot.all("*", (c) => c.json({ error: "the runtime handler" }, 500));

  const args: unknown[] = [];
  args[0] = config;
  args[1] = auth;
  // The transcript route is registered inside `if (copilotHandler)`, so without one there is no
  // route to reach and the request falls through to something that is not this route at all.
  args[5] = copilot;
  // The twenty-fourth argument, and the only one this file needs.
  args[23] = database;

  const app = (
    createApp as unknown as (
      ...a: unknown[]
    ) => Hono<{ Variables: AppVariables }>
  )(...args);
  return app;
}

const readBack = (app: Hono<{ Variables: AppVariables }>, threadId: string) =>
  app.request(
    `http://test/api/copilotkit/threads/${encodeURIComponent(threadId)}/messages?agentId=channel:x`,
  );

describe("a conversation a hop wrote", () => {
  test("is readable by the person whose channel it is", async () => {
    /*
     * THE SHAPE THE BUG PRODUCED, built directly: the thread the hop wrote into has no owner,
     * because `ensureThread` saw it first and knew a run rather than a person. Every message in it
     * is real and none of it is readable.
     */
    const threadId = `deleg-bugged-${randomUUID()}`;
    createdThreadIds.push(threadId);
    await threadStore.ensureThread({ threadId, agentId: "agent-coco" });
    await threadStore.appendMessages(threadId, [
      {
        id: randomUUID(),
        role: "user",
        content: "Remii has asked you to help with this.",
      } as never,
      {
        id: randomUUID(),
        role: "assistant",
        content: "Draft written and saved.",
      } as never,
    ]);

    // The route excludes an unowned thread, so the read is empty rather than wrong. This is what a
    // person saw: a channel in their roster and an empty conversation.
    const before = await readBack(appAs(OWNER), threadId);
    // Printed once, because a test that reports `[]` against `undefined` is a test that has found
    // nothing and does not know it.
    const beforeBody = (await before.json()) as { messages: unknown[] };
    expect(before.status).toBe(200);
    expect(beforeBody.messages).toEqual([]);
    expect(beforeBody.messages).toEqual([]);

    // Somebody who knows the owner names the thread again — which is what opening the conversation
    // does. Before the fix this changed nothing, because the writer ignored the conflict.
    await threadStore.ensureThread({ threadId, userId: OWNER });

    const after = await readBack(appAs(OWNER), threadId);
    const afterRaw = await after.text();
    const afterBody = (afterRaw ? JSON.parse(afterRaw) : {}) as {
      messages?: { role: string; content: string }[];
    };
    expect(afterBody.messages ?? []).toHaveLength(2);
    expect(afterBody.messages?.[0]?.content ?? "").toContain(
      "Remii has asked you to help with this",
    );
    expect(afterBody.messages?.[1]?.content ?? "").toContain(
      "Draft written and saved",
    );
  });

  test("and stays unreadable to everybody else", async () => {
    // The owner check is the only thing between one person's conversation and another's, so the fix
    // that fills a missing owner in must not become a fix that fills any owner in.
    const threadId = `deleg-private-${randomUUID()}`;
    createdThreadIds.push(threadId);
    await threadStore.ensureThread({ threadId, agentId: "agent-coco" });
    await threadStore.ensureThread({ threadId, userId: OWNER });
    await threadStore.appendMessages(threadId, [
      { id: randomUUID(), role: "user", content: "private" } as never,
    ]);

    const stranger = await readBack(appAs(STRANGER), threadId);
    const body = (await stranger.json()) as { messages: unknown[] };
    expect(body.messages).toEqual([]);
  });

  test("and a second claim does not take the conversation away", async () => {
    const threadId = `deleg-claimed-${randomUUID()}`;
    createdThreadIds.push(threadId);
    await threadStore.ensureThread({ threadId, userId: OWNER });
    await threadStore.appendMessages(threadId, [
      { id: randomUUID(), role: "user", content: "mine" } as never,
    ]);

    // A later run names the same thread while somebody else is asking. If this could set the owner,
    // any run anywhere could move a conversation to whoever happened to be signed in.
    await threadStore.ensureThread({
      threadId,
      userId: STRANGER,
      agentId: "agent-other",
    });

    expect(
      (
        (await (await readBack(appAs(OWNER), threadId)).json()) as {
          messages: unknown[];
        }
      ).messages,
    ).toHaveLength(1);
    expect(
      (
        (await (await readBack(appAs(STRANGER), threadId)).json()) as {
          messages: unknown[];
        }
      ).messages,
    ).toHaveLength(0);
  });
});
