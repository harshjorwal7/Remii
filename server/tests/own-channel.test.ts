import { describe, expect, test } from "bun:test";
import { ownChannelFor, resolveOwnChannel } from "../src/agents/own-channel";
import type { AgentChannel } from "../src/channels/routes";

/**
 * A CHANNEL ID AND A THREAD ID ARE NOT INTERCHANGEABLE.
 *
 * This file exists because they were treated as interchangeable, and the only symptom was a person
 * looking at an empty screen. Coco's channel appeared in the roster with nothing in it; the email
 * draft was written; Coco had asked the person to confirm a guessed first name; and none of it was
 * anywhere they could read, because the hop had run in a thread invented on the spot and NAMED AFTER
 * THE CHANNEL. The bug was `ownThreadFor` returning `channel.id` where the delivery wanted a thread.
 *
 * Two tests, and they are not the same test:
 *
 *   - `ownChannelFor` maps a channel's two ids onto two named fields. It cannot be asked for one
 *     field and get the other, which is the property that makes the mistake unmakeable.
 *   - `resolveOwnChannel` is what `index.ts` actually calls, so the wiring is covered rather than a
 *     test double that happens to agree with it. The handoff suite's own double was how this got
 *     through: it took one string for both ids, so every test above it passed while the production
 *     wiring was wrong.
 */

const CHANNEL: AgentChannel = {
  id: "channel_fc380b3b-766d-452f-8605-e347f55c96d8",
  name: "Coco",
  agentIds: ["agent_5212383f"],
  // A deployment-minted v8 uuid, which is what every real channel thread looks like and what a
  // channel id never looks like.
  threadId: "55569917-dab5-8d1e-9c6a-6d1d8152aa01",
  active: true,
};

describe("a channel and its thread", () => {
  test("are read as two different ids", () => {
    const own = ownChannelFor(CHANNEL);

    expect(own.channelId).toBe("channel_fc380b3b-766d-452f-8605-e347f55c96d8");
    expect(own.threadId).toBe("55569917-dab5-8d1e-9c6a-6d1d8152aa01");
  });

  test("and neither is the other, which is the whole point of the type", () => {
    const own = ownChannelFor(CHANNEL);

    // Written as two separate assertions rather than one `toMatchObject` so that swapping the two
    // lines above fails HERE, in a test whose name says what the property is.
    expect(own.threadId).not.toBe(own.channelId);
    expect(own.channelId).not.toBe(own.threadId);
  });
});

describe("resolving a coworker's own conversation", () => {
  const actor = { id: "user-1", role: "user" as const };

  test("hands back the channel's own thread, not its id", async () => {
    // THE CALL THE SERVER MAKES. Before the fix this returned the channel id and the delegation was
    // invisible; the assertion is written to fail if it ever does again.
    const own = await resolveOwnChannel(
      "user-1",
      "agent_5212383f",
      async () => CHANNEL,
      async () => actor,
    );

    expect(own?.threadId).toBe(CHANNEL.threadId);
    expect(own?.channelId).toBe(CHANNEL.id);
  });

  test("asks the store for the channel by the person and the Bot, never anything the model named", async () => {
    const asked: { actorId: string; botId: string }[] = [];

    await resolveOwnChannel(
      "user-1",
      "agent_5212383f",
      async (actorArg, botId) => {
        asked.push({ actorId: actorArg.id, botId });
        return CHANNEL;
      },
      async () => actor,
    );

    expect(asked).toEqual([{ actorId: "user-1", botId: "agent_5212383f" }]);
  });

  test("says nothing rather than throwing when the person cannot be resolved", async () => {
    // The caller turns null into a refusal with a sentence. A thrown error here ends the run in
    // silence, which is how a person finds out their Bot stopped.
    const own = await resolveOwnChannel(
      "user-1",
      "agent_5212383f",
      async () => CHANNEL,
      async () => {
        throw new Error("the person could not be resolved");
      },
    );

    expect(own).toBeNull();
  });

  test("says nothing when the store finds no channel, rather than inventing one", async () => {
    const own = await resolveOwnChannel(
      "user-1",
      "agent_5212383f",
      async () => null,
      async () => actor,
    );

    expect(own).toBeNull();
  });
});
