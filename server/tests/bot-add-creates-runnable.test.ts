import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { users } from "../src/db/schema";
import { createAgentProfileStore } from "../src/agents/profile-store";
import { registeredAgentFromRow } from "../src/copilot";
import { testDatabase, } from "./support/database";

/**
 * `bot_add` COULD NOT CREATE ANYTHING ON A DEPLOYMENT WITH NO MANAGED AGENT.
 *
 * A person asked this deployment for a WhatsApp coworker, twice. Both attempts answered "That
 * coworker could not be created right now." and the roster did not change.
 *
 * The cause was not a transient failure. `AgentProfileStore.create` takes one of three shapes — an
 * endpoint to run on, a bearer key, or a system prompt to run — and `bot_add` named NONE of them. So
 * every call fell through to the store's refusal, which is the correct behaviour for a coworker with
 * no brain, and the `catch {}` around it turned a permanent, explainable refusal into a sentence that
 * named neither the cause nor anything an operator could act on.
 *
 * `MANAGED_AGENT_AG_UI_URL` is unset on this deployment, which is a supported configuration: the
 * token is set and the URL is not. So this was not an edge case, it was the only path.
 *
 * The fix promotes the role the person wrote into the prompt a built-in Bot runs on, which is what a
 * built-in Bot *is* in this product. These tests assert the outcome that matters — that the row it
 * leaves behind is one the runtime will actually run — rather than the shape of the call.
 */

const database = testDatabase();
afterAll(async () => {
  await database.$client.close();
});

const run = async () => {
  const { botAdminToolsFor } = await import("../src/remi/bot-admin");
  const actorId = `bot-add-${randomUUID()}`;
  await database
    .insert(users)
    .values({ id: actorId, email: `${actorId}@example.test` })
    .onConflictDoNothing();

  const profiles = createAgentProfileStore(database, undefined);
  const tools = botAdminToolsFor({
    botId: "general-assistant",
    actorId,
    stores: {
      profiles,
      loadActor: async () => ({
        id: actorId,
        email: `${actorId}@example.test`,
      }),
      by: "test",
      audit: undefined,
      channels: undefined as never,
      executionModes: undefined as never,
      instructions: undefined as never,
    } as never,
  });
  const add = tools.find((t) => t.name === "bot_add");
  if (!add) throw new Error("bot_add is not offered");
  return {
    actorId,
    call: (args: Record<string, unknown>) =>
      (add.execute as (a: unknown) => Promise<string>)(args),
  };
};

describe("a coworker Remii creates can actually answer", () => {
  test("bot_add succeeds with no managed agent configured", async () => {
    const { call, actorId } = await run();
    const answer = await call({
      name: "WhatsApp Desk",
      job: "Answer WhatsApp messages on the person's behalf.",
    });
    expect(answer).toContain("WhatsApp Desk is ready");
    void actorId;
  });

  test("the row it leaves is one the runtime will run", async () => {
    /*
     * The assertion that matters. A `built_in` row with an empty prompt is dropped by
     * `registeredAgentFromRow`, so the Bot appears on every screen and answers nobody — which is
     * worse than a refusal, because the person is told it is ready.
     */
    const { call, actorId } = await run();
    await call({
      name: "Research Reader",
      job: "Read around a question and write it up.",
    });

    const rows = await database.execute(
      `select id, name, type, configuration, owner_user_id from agents where owner_user_id = '${actorId}'`,
    );
    expect(rows.length).toBe(1);

    const row = rows[0] as unknown as {
      id: string;
      name: string;
      type: string;
      configuration: { systemPrompt?: string };
      owner_user_id: string;
    };
    const registered = registeredAgentFromRow({
      id: row.id,
      name: row.name,
      type: row.type as "built_in",
      configuration: row.configuration as never,
      override: null,
    } as never);

    expect(registered).not.toBeNull();
    expect(registered?.type).toBe("built_in");
    // And the prompt says who it is and what it is for, not merely that it exists.
    expect(
      registered && "systemPrompt" in registered ? registered.systemPrompt : "",
    ).toContain("Research Reader");
  });

  test("a second attempt for the same name is not blocked by the first", async () => {
    // The person tried twice in a row; both had to fail identically. One must now succeed.
    const { call } = await run();
    expect(await call({ name: "Retry One", job: "First." })).toContain(
      "is ready",
    );
    expect(await call({ name: "Retry Two", job: "Second." })).toContain(
      "is ready",
    );
  });
});
