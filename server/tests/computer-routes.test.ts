import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import type { AppVariables, AuthenticatedActor } from "../src/auth/guards";
import type { ComputerGateway } from "../src/computer/gateway";
import type { PolicyStore } from "../src/computer/policy-store";
import { createComputerRoutes } from "../src/computer/routes";

describe("computer routes", () => {
  test("gets a screenshot through the governed computer gateway", async () => {
    const requestedBotIds: string[] = [];
    const gateway = {
      screenshot: async (botId: string) => {
        requestedBotIds.push(botId);
        return { image: "aGVsbG8=", mimeType: "image/png" as const };
      },
    } as unknown as ComputerGateway;
    const policyStore = {} as PolicyStore;
    /*
     * Sets the actor, which it did not used to.
     *
     * The middleware was `(_context, next) => next()`, so `context.var.actor` was never assigned and
     * every acting route that reads it — the gateway key is built from `actor.id` — threw on the way
     * past. The 500 the test then reported read as a broken gateway seam when it was a stub that had
     * stopped matching what a signed-in caller looks like.
     */
    const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
      context,
      next,
    ) => {
      context.set("actor", {
        id: "user-1",
        email: "member@remii.test",
        role: "user",
      });
      await next();
    };
    // Permissive: what this covers is the gateway seam, not who may act as the Bot. That question
    // has its own suite in bot-access.test.ts.
    const routes = createComputerRoutes(
      gateway,
      policyStore,
      requireUser,
      async () => true,
    );

    const response = await routes.request(
      "http://remii.test/bot-17/screenshot",
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      image: "aGVsbG8=",
      mimeType: "image/png",
    });
    expect(requestedBotIds).toEqual(["bot-17"]);
  });
});

/**
 * The fleet listing is the one route here that is not about the Bot in its path.
 *
 * `:botId` is ignored and the handler returns every computer, so a signed-in person asking about a
 * Bot they own learned every Bot id in the deployment and whether its computer was running,
 * private coworkers included. Being signed in is not the question; administering the deployment is.
 */
const member: AuthenticatedActor = {
  id: "user-1",
  email: "member@remii.test",
  role: "user",
};

const _administrator: AuthenticatedActor = {
  id: "admin-1",
  email: "admin@remii.test",
  role: "admin",
};

function asActor(
  actor: AuthenticatedActor,
): MiddlewareHandler<{ Variables: AppVariables }> {
  return async (context, next) => {
    context.set("actor", actor);
    await next();
  };
}

function appFor(actor: AuthenticatedActor, computers: () => Promise<unknown>) {
  let listed = 0;
  const countingGateway = {
    async computers() {
      listed += 1;
      return computers();
    },
  } as ComputerGateway;

  return {
    app: createComputerRoutes(
      countingGateway,
      {} as PolicyStore,
      asActor(actor),
      // Permissive. Whether this person may act as the Bot in the path is a different question with
      // its own suite, and `:botId` is not what this route answers about anyway.
      async () => true,
    ),
    listed: () => listed,
  };
}

/*
 * WAS two tests about `/:botId/computers`: a signed-in member refused with 403 and
 * "Administrator access required.", an administrator handed the whole fleet.
 *
 * Neither route nor role exists now. `/:botId/computers` is gone with the admin surface, and there
 * is no administrator to be refused — every signed-in person is a user. So both were 404ing against
 * assertions about an authorization decision nobody makes.
 *
 * What replaced it is `GET /fleet`, which answers with the caller's OWN computers and filters on
 * `owner`; `computer-fleet-route.test.ts` holds that down in full. What is worth keeping here is the
 * gateway: it must be asked exactly once, and only for the caller, so a coworker's computer can never
 * reach them even by omission.
 */
describe("the fleet the caller owns", () => {
  test("answers with their own computers, and asks the gateway once", async () => {
    const fleet = {
      isolation: "per-bot" as const,
      computers: [
        {
          botId: "their-computer",
          running: true,
          startedAt: "2026-08-20T00:00:00.000Z",
          owner: member.id,
          egress: null,
        },
        {
          botId: "a-coworkers-computer",
          running: true,
          startedAt: "2026-08-20T00:00:00.000Z",
          owner: "somebody-else",
          egress: null,
        },
      ],
    };
    const { app, listed } = appFor(member, async () => fleet);

    const response = await app.request("http://remii.test/fleet");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      isolation: "per-bot",
      computers: [fleet.computers[0]],
    });
    // Once. Two reads would mean the list was assembled by asking twice and hoping.
    expect(listed()).toBe(1);
  });
});

/**
 * The kind of human input is what the path says, and only what the path says.
 *
 * The route checks `:kind` against the four gestures a person's mouse and keyboard produce, and then
 * built the call as `{ kind, ...body }`, so a body carrying its own `kind` replaced the value that
 * had just been checked. The gateway puts that value straight into the path it calls on the
 * computer, so the check decided one thing and the request went somewhere else.
 *
 * This route is the one that deliberately skips the policy decision and the audit row, because a
 * takeover exists so a person can type the thing nothing should keep. That makes it the worst one to
 * be able to redirect: nothing downstream writes the row that would have shown where it went.
 */
describe("human input", () => {
  function recordingGateway() {
    const calls: Array<{ botId: string; input: Record<string, unknown> }> = [];
    const gateway = {
      humanInput: async (botId: string, input: Record<string, unknown>) => {
        calls.push({ botId, input });
        return { ok: true };
      },
    } as unknown as ComputerGateway;
    return {
      calls,
      app: createComputerRoutes(
        gateway,
        {} as PolicyStore,
        asActor(member),
        async () => true,
      ),
    };
  }

  async function send(body: unknown, kind = "click") {
    const { app, calls } = recordingGateway();
    const response = await app.request(
      `http://remii.test/bot-1/human/${kind}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    return { response, calls };
  }

  test("carries a real gesture through with its coordinates", async () => {
    const { response, calls } = await send({ x: 10, y: 20 });

    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input.kind).toBe("click");
    expect(calls[0]?.input.x).toBe(10);
  });

  test("a body naming its own kind does not decide where the call goes", async () => {
    // `../computers/reset` is the shape that matters: the gateway interpolates this into the path it
    // calls, and a fetch resolves the `..` away, so the request lands on a different endpoint of the
    // computer's API carrying the deployment's computer token.
    const { calls } = await send({ kind: "../computers/reset", x: 1, y: 1 });

    expect(calls[0]?.input.kind).toBe("click");
  });

  test("a body naming its own kind cannot reach the shell either", async () => {
    const { calls } = await send(
      { kind: "../exec", text: "cat /workspace/notes" },
      "type",
    );

    expect(calls[0]?.input.kind).toBe("type");
  }, 10_000);

  test("a kind the path does not allow is still refused", async () => {
    // The existing check, which must go on working: the four gestures are the whole surface.
    const { response, calls } = await send({ x: 1 }, "screenshot");

    expect(response.status).toBe(400);
    expect(calls).toHaveLength(0);
  });
});
