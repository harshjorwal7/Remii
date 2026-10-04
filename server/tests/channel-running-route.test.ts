import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AppVariables } from "../src/app";
import {
  type AgentChannel,
  type ChannelStore,
  ChannelNotFoundError,
  createChannelRoutes,
} from "../src/channels/routes";

/**
 * THE READ THAT LETS A CONVERSATION YOU LEFT CAME BACK TO.
 *
 * Everything a mounted conversation knows about its own run state is created when it mounts and
 * destroyed when it unmounts: `agent.isRunning` belongs to a `useAgent` instance that is registered on
 * mount and unregistered on unmount, and `turnsInFlight` / `runsInFlight` are `useState` counters that
 * start at zero. So a person who leaves a long task and comes back arrives at a screen that believes
 * nothing is happening, while a run they never stopped is still going on the server.
 *
 * That is what this route answers. It is deliberately not derived from the socket, and deliberately not
 * folded into the roster payload: the socket carries activity as it happens for surfaces that were
 * already open, and this is for the one surface that was not. The tests below are about the properties
 * that make it usable as the composer's source of truth — in particular that it distinguishes "nothing
 * is running" from "this is not your channel", because a Stop button that appears for a run it cannot
 * reach is worse than no Stop button.
 */

const actor = {
  id: "user-1",
  email: "member@remii.test",
  role: "user",
} as const;

function channel(overrides: Partial<AgentChannel> = {}): AgentChannel {
  return {
    id: "channel-1",
    name: "Assistant channel",
    agentIds: ["agent-1"],
    threadId: "thread-1",
    active: true,
    lastMessageAt: null,
    ...overrides,
  };
}

const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
  context,
  next,
) => {
  context.set("actor", actor);
  await next();
};

function appFor(store: Partial<ChannelStore>) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.route("/", createChannelRoutes(store as ChannelStore, requireUser));
  return app;
}

async function json(response: Response) {
  return (await response.json()) as {
    activity?: { state: string; botId: string; label: string | null } | null;
    error?: string;
  };
}

describe("reading whether a conversation is mid-run", () => {
  test("answers with the run that is going, so the composer can offer to stop it", async () => {
    const app = appFor({
      async runningIn() {
        return {
          state: "thinking" as const,
          label: null,
          detail: null,
          botId: "agent-1",
        };
      },
    });

    const body = await json(
      await app.request("http://remii.test/channel-1/activity"),
    );

    expect(body.activity?.state).toBe("thinking");
  });

  test("answers null when nothing is running, which is a fact and not an absence", async () => {
    const app = appFor({
      async runningIn() {
        return null;
      },
    });

    const body = await json(
      await app.request("http://remii.test/channel-1/activity"),
    );

    /*
     * `activity: null` rather than `{ running: false }`.
     *
     * A caller that has to tell "no run" apart from "the server could not answer" will eventually get it
     * wrong, and the wrong way round is a Stop button on a conversation with nothing to stop.
     */
    expect(body.activity).toBeNull();
  });

  test("refuses a channel the caller is not in, as 404 and not as an empty answer", async () => {
    /*
     * The distinction that keeps this from being an oracle. A 404 says "there is nothing here"; a 200
     * with `activity: null` would say "here is a conversation and nothing is running in it" — which, for
     * somebody probing channel ids, is a free list of which conversations exist.
     */
    const app = appFor({
      async runningIn() {
        // The store's own error, because the route maps errors by identity: a generic Error with a
        // `status` field on it is not something `mapStoreError` knows, and it would answer 500.
        throw new ChannelNotFoundError("somebody-elses");
      },
    });

    const response = await app.request(
      "http://remii.test/somebody-elses/activity",
    );

    expect(response.status).toBe(404);
  });

  test("is scoped to the caller, so it cannot be asked about somebody else's work", async () => {
    const seen: string[] = [];
    const app = appFor({
      async runningIn(receivedActor, channelId) {
        seen.push(`${receivedActor.id}:${channelId}`);
        return null;
      },
    });

    await app.request("http://remii.test/channel-1/activity");

    expect(seen).toEqual(["user-1:channel-1"]);
  });

  test("rejects a blank channel id rather than asking about nothing", async () => {
    let asked = false;
    const app = appFor({
      async runningIn() {
        asked = true;
        return null;
      },
    });

    /*
     * `/:channelId` will not match an empty segment, so this is asking what a whitespace id does — and
     * a whitespace id reaches the store, where it is a real string that matches no channel and answers
     * 404, which is a worse answer than 400 for a malformed call.
     */
    const response = await app.request("http://remii.test/%20/activity");

    expect(response.status).toBe(400);
    expect(asked).toBe(false);
  });

  test("does not shadow the POST that records activity, or the socket upgrade", async () => {
    const calls: string[] = [];
    const app = appFor({
      async runningIn() {
        return null;
      },
      async recordActivity() {
        calls.push("post");
      },
    });

    /*
     * Both halves matter, and one is a live bug if it regresses: this route sits at `/:channelId/activity`
     * and the recording POST sits at exactly the same path with a different method, so adding a GET here
     * is the kind of change that quietly turns a POST into a 404 in whichever framework resolves static
     * before dynamic. The socket is `/events`, registered before `/:channelId` so that path is never
     * read as a channel id; a new `/:channelId/...` route must not reintroduce that.
     */
    const post = await app.request("http://remii.test/channel-1/activity", {
      method: "POST",
      headers: { "content-type": "application/json" },
      // The full shape `parseActivityInput` requires: text, an agent or an explicit null, and an
      // ISO-8601 instant. Anything less is refused at 400 for a malformed call, which would say
      // nothing about whether this GET shadowed it.
      body: JSON.stringify({
        text: "hello",
        agentId: null,
        at: new Date().toISOString(),
      }),
    });

    expect(post.status).toBe(204);
    expect(calls).toEqual(["post"]);
  });
});
