/**
 * Who is driving the user's desktop.
 *
 * The shortest possible honest answer to "the person or the Bot", and the only part of takeover
 * that is a decision rather than a mechanism. Everything else follows from it: the desktop tools
 * refuse to act while a person holds it, and the refusal names the reason so the Bot waits instead
 * of retrying.
 *
 * Deliberately three routes and nothing else. A wheel needs a holder, a way to take it and a way to
 * give it back; every additional verb here is a way for two writers to disagree about who is
 * driving, which is the failure this exists to prevent.
 */

import type { Context, MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AppVariables } from "../auth/guards";
import type { BotComputer, BotComputerStore } from "./bot-computers";
import type { DesktopStreamSession } from "./desktop-stream";
import type { UserComputerStore } from "./user-computers";

/**
 * The one computer a person has, and what it has cost them.
 *
 * `isolation` is a constant rather than a field that could disagree, because there is exactly one
 * computer per person here and a page that had to be told so could one day be told otherwise. It is in
 * the shape so the browser does not have to hardcode the same fact.
 */
export type DesktopState = {
  computer: {
    status: string;
    /** Real geometry, read back from the running desktop. Never assumed. */
    displayWidth: number | null;
    displayHeight: number | null;
    lastSeenAt: string | null;
  };
  hoursUsed: number;
  hoursIncluded: number;
  isolation: "per-person";
};

/**
 * How recently each person's screen was looked at, per process.
 *
 * Only ever read to decide whether a write is due, so an entry that outlives its usefulness costs
 * nothing but a few bytes — there is no cleanup, deliberately, because a `setInterval` sweeping a map
 * is more machinery than the problem deserves and a periodic timer is one more thing to stop when the
 * server shuts down.
 */
const watchedAt = new Map<string, number>();

/**
 * How often `last_seen_at` may be rewritten by looking at the screen.
 *
 * Thirty seconds, matching the provisioner's own `touch` cadence for the same column. The idle sweep
 * that reads this decides on a scale of minutes, so a slower write cannot change its answer, and the
 * browser polls this route far more often than that.
 */
const WATCH_WRITE_INTERVAL_MS = 30_000;

/**
 * Record that a person is looking at this computer right now.
 *
 * Fire-and-forget on purpose: this rides along with a status poll whose answer must not wait on a
 * write, and a failed heartbeat costs one idle sweep's opinion rather than the request. Nothing is
 * awaited and nothing is thrown — the desktop being watched is unaffected either way.
 */
function markWatched(store: UserComputerStore, userId: string): void {
  const now = Date.now();
  if (now - (watchedAt.get(userId) ?? 0) < WATCH_WRITE_INTERVAL_MS) return;
  watchedAt.set(userId, now);
  void Promise.resolve(store.patch(userId, { lastSeenAt: new Date() })).catch(
    () => undefined,
  );
}

export function createDesktopControlRoutes(
  store: UserComputerStore,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
  /**
   * Per-Bot wheels, and `null` everywhere in this deployment.
   *
   * There is one computer per person and Remii holds it, so a per-Bot wheel has nothing to turn. The
   * routes are KEPT and answer 404 without a store rather than being deleted, for two reasons: a client
   * still asking is told "no such computer" instead of getting a shape it would have to handle, and the
   * code that would bring them back stays compiled and typechecked rather than rotting in a branch.
   *
   * Passed rather than created so this module keeps no database handle of its own.
   */
  botStore: BotComputerStore | null,
  /**
   * The Bots this person owns, for the fleet page.
   *
   * Injected rather than imported so this router keeps no database handle of its own. Every entry is
   * the person SIGNED IN, never a deployment-wide list: "what can I watch" and "what exists" are
   * different questions and answering the second with the first is how one person ends up able to
   * see another's Bot.
   */
  listBots?: (userId: string) => Promise<{ id: string; name: string }[]>,
  /**
   * What this person's one computer is, and the hours behind it.
   *
   * A callback rather than a store, for the reason every other collaborator here is one: this module
   * keeps no database handle and no billing logic, so the price policy stays in `billing/` and the
   * lifecycle stays in `user-computers`. Absent answers 503 rather than inventing a shape.
   */
  describeComputer?: (userId: string) => Promise<DesktopState | null>,
  /**
   * One still frame of the desktop, for the inline card and for zooming a finished turn.
   *
   * This is NOT the live screen and is not a cheaper version of it. The live screen is noVNC, which
   * streams only what changed; a still is a single full-resolution capture used where there is no live
   * stream to have: the collapsed card beside a run, and the picture a settled turn keeps so that
   * zooming one shows what it did rather than whatever the Bot has open now.
   *
   * Resolving without starting anything. The card polls this the moment a page opens, and a poll that
   * could create a sandbox would mean opening a chat costs a machine.
   *
   * `url` is absent on this path. It used to carry the active browser's URL, which was how the card
   * knew to show "no page open" instead of a picture of a blank window. There is no active-URL concept
   * on a hosted desktop — what is in front is whatever window the Bot opened — so absence means
   * "there is a screen here", which shows the picture rather than hiding it.
   */
  captureStill?: (userId: string) => Promise<{
    base64: string;
    width: number;
    height: number;
  } | null>,
  /**
   * Open this person's live screen, resuming their desktop if it is paused.
   *
   * A collaborator rather than a store, because opening the screen has to be able to START a machine
   * and mint a VNC password — which is the provisioner's job and nobody else's. This module keeps no
   * database handle and no platform knowledge, so the desktop is still reachable from the socket and
   * the tools without either of them knowing what platform they are talking to.
   *
   * Absent answers 503 rather than inventing a shape, exactly as {@link describeComputer} does.
   */
  openStream?: (userId: string) => Promise<DesktopStreamSession>,
  /**
   * Pause this person's computer, reversibly.
   *
   * A collaborator rather than a store, because pausing is the provisioner's job — it owns the sandbox
   * handle and the billing session — and this module keeps no platform knowledge at all. Absent means
   * there is nothing to pause, which is answered rather than treated as a failure.
   */
  stopComputer?: (scope: { key: string; userId: string }) => Promise<void>,
  /**
   * Delete this person's row AND their sandbox, which is what makes it a reset rather than a stop.
   *
   * Separate from `stopComputer` and named for the difference: a pause is a thing you can come back
   * from and a reset is not, and one function that quietly did the first when asked for the second
   * would be the worst kind of bug this file could have.
   */
  removeComputer?: (userId: string) => Promise<boolean>,
  /**
   * What this person is being asked to type, if anything.
   *
   * Read by `/control` so the browser knows whether to show the masked box. `undefined` means nothing
   * is outstanding, which is what the prompt tests for.
   */
  readSecretWanted?: (userId: string) => string | undefined,
  /**
   * Hand a typed value to whoever is waiting for it.
   *
   * Returns false when nobody is, so the browser can say so instead of accepting a password into a
   * void. The value is not retained by this module or by `desktop-secrets`.
   */
  supplySecret?: (userId: string, text: string) => boolean,
) {
  const app = new Hono<{ Variables: AppVariables }>();
  const read = (
    holder: "bot" | "human" | undefined,
    since: Date | undefined,
  ) => ({
    holder: holder ?? "bot",
    since: (since ?? new Date()).toISOString(),
  });

  /*
   * The current holder. Answered from the row, and defaulting to the Bot.
   *
   * The default is the safe direction: a person who has not taken the wheel should not have to
   * prove they have not, and a Bot that meets a missing row should get on with the work.
   */
  app.get("/control", requireUser, async (context) => {
    const userId = context.var.actor.id;
    const row = await store.get(userId);
    /*
     * "Somebody has this computer open on their screen" counts as using it.
     *
     * Without this, a person watching their Bot work — the exact thing this product is for — could
     * have the machine paused out from under them. The idle sweep reads `last_seen_at`, and until now
     * the only thing that wrote it was a tool call, so a screen sitting still after the Bot finished
     * a step stopped looking alive and got reclaimed while it was being looked at. The noVNC bytes go
     * from the browser straight to the sandbox and never pass through this process, so nothing else
     * here could possibly notice that a human was present.
     *
     * This is the cheapest honest signal available: a poll the browser already makes, answered from the
     * row this handler was going to read anyway. It costs one throttled database write and, crucially,
     * NO round trip to the sandbox — unlike the screenshot poll, which resolves the whole desktop just
     * to draw a frame. So the machine stays alive for someone watching without competing with the Bot
     * for the machine it is driving.
     *
     * Throttled to the same cadence the provisioner uses for its own `touch`, because a write per
     * poll would put a database write in front of every status check, and because the sweep's own
     * resolution is minutes — thirty seconds of staleness cannot change its answer.
     */
    markWatched(store, userId);
    const secretWanted = readSecretWanted?.(userId);
    return context.json({
      ...read(row?.controlHolder, row?.controlSince),
      /*
       * `secretWanted` is how the masked box knows to appear, and it is ABSENT when nothing is being
       * asked for rather than `null` — the prompt treats presence as the signal, and an explicit null
       * reads as a request for a blank value.
       */
      ...(secretWanted ? { secretWanted } : {}),
    });
  });

  /**
   * A person supplying the value a Bot asked for.
   *
   * Its own route rather than a `kind` on an input route, so that grepping this server for where a
   * secret can enter returns exactly one place. That was true before, when the per-Bot router was
   * mounted, and it stopped being true when the per-Bot router was not — which is why the prompt in the
   * browser was POSTing into a 404 and the Bot was told nobody had answered.
   *
   * The value is read, handed on and not kept. This handler never logs it, never returns it and never
   * stores it; see `desktop-secrets.ts`.
   */
  app.post("/human/secret", requireUser, async (context) => {
    const body = (await context.req.json().catch(() => null)) as {
      text?: unknown;
    } | null;
    if (typeof body?.text !== "string" || !body.text) {
      return context.json({ error: "A value is required." }, 400);
    }
    if (!supplySecret?.(context.var.actor.id, body.text)) {
      // Nobody is waiting, which means the Bot gave up or the box was reopened. Said plainly rather
      // than accepted silently, so a person who typed a password into a box that had already gone is
      // not left believing it went somewhere.
      return context.json(
        { error: "Nothing is waiting for that value any more." },
        409,
      );
    }
    return context.json({ ok: true });
  });

  /**
   * Take the wheel.
   *
   * It does not stop the sandbox or the Bot's run. The Bot is refused at its next action and told a
   * person has control, which is a far better outcome than a frozen run: it can finish its sentence
   * and stop, and it resumes the moment the wheel comes back.
   */
  app.post("/control/take", requireUser, async (context) => {
    const row = await store.patch(context.var.actor.id, {
      controlHolder: "human",
    });
    /*
     * Taking the wheel is the strongest possible statement that this computer is wanted, so it counts
     * as activity for the idle sweep even before any tool call follows. The browser polls `/control`
     * continuously anyway, so this is belt-and-braces rather than the only signal — but it makes the
     * intent explicit at the exact moment it is expressed, which is worth a throttled write.
     */
    markWatched(store, context.var.actor.id);
    return context.json(read(row?.controlHolder ?? "human", row?.controlSince));
  });

  app.post("/control/release", requireUser, async (context) => {
    const row = await store.patch(context.var.actor.id, {
      controlHolder: "bot",
    });
    return context.json(read(row?.controlHolder ?? "bot", row?.controlSince));
  });

  /**
   * Open the live screen: the noVNC URL and its password.
   *
   * A URL and a credential, not a stream of pixels, and this is the endpoint that fixed the live
   * screen feeling unusable. It used to be a websocket the browser subscribed to, over which the
   * server pushed one base64 JPEG per frame captured from a remote screenshot API — so the frame rate
   * was the platform's round-trip latency, and every mouse move the person made was another round
   * trip. See the module comment in `desktop-stream.ts` for what that cost in practice.
   *
   * What the browser gets instead is noVNC talking RFB directly to the desktop, so frames cost only
   * what changed and input never touches this process. The latency stops being a function of how many
   * API calls a picture costs, which is the only reason it could be fixed at all.
   *
   * The password is returned SEPARATELY from the URL on purpose. Folding it into the query string
   * would put a working credential in every proxy log between here and the browser, in browser
   * history, and in the `Referer` of anything the page loads.
   *
   * Starts the machine if it is paused, because opening the screen is a request to use it. A desktop
   * still provisioning answers 503, which is a fact about timing rather than a fault.
   */
  app.get("/screenshot", requireUser, async (context) => {
    if (!captureStill) {
      return context.json({ error: "This deployment has no desktop." }, 503);
    }
    try {
      const still = await captureStill(context.var.actor.id);
      if (!still) {
        return context.json({ error: "This computer is not running." }, 503);
      }
      return context.json({
        frame: { ...still, capturedAt: new Date().toISOString() },
      });
    } catch (error) {
      return context.json(
        {
          error:
            error instanceof Error
              ? error.message
              : "The screen could not be read.",
        },
        503,
      );
    }
  });

  app.get("/stream", requireUser, async (context) => {
    if (!openStream) {
      return context.json({ error: "This deployment has no desktop." }, 503);
    }
    try {
      const session: DesktopStreamSession = await openStream(
        context.var.actor.id,
      );
      return context.json({
        url: session.url,
        authKey: session.authKey,
        width: session.width,
        height: session.height,
      });
    } catch (error) {
      return context.json(
        {
          error:
            error instanceof Error
              ? error.message
              : "The screen could not be opened.",
        },
        503,
      );
    }
  });

  /*
   * The same wheel, per Bot.
   *
   * Separate addresses rather than a query parameter because these are different machines, and a
   * URL that names the machine is one a person can read back and be sure what they are about to
   * drive. The person-level routes above stay exactly where they are.
   *
   * Ownership is checked on every call, not only on the list: a Bot id is guessable, and a wheel
   * that let one person stop another's Bot would be a denial of service wearing a UI.
   */
  app.get("/bot/:botId/control", requireUser, async (context) => {
    const bot = await readOwnedBot(context);
    if (!bot) return notFound(context);
    return context.json(read(bot.controlHolder, bot.controlSince));
  });

  app.post("/bot/:botId/control/take", requireUser, async (context) => {
    const owned = await readOwnedBot(context);
    // `readOwnedBot` answers null without a store, so a bot here means there is one.
    if (!owned || !botStore) return notFound(context);
    const row = await botStore.patch(owned.botId, { controlHolder: "human" });
    return context.json(read(row?.controlHolder ?? "human", row?.controlSince));
  });

  app.post("/bot/:botId/control/release", requireUser, async (context) => {
    const owned = await readOwnedBot(context);
    if (!owned || !botStore) return notFound(context);
    const row = await botStore.patch(owned.botId, { controlHolder: "bot" });
    return context.json(read(row?.controlHolder ?? "bot", row?.controlSince));
  });

  /**
   * Hand back every wheel this person holds, at once.
   *
   * The escape hatch a per-Bot wheel makes necessary. Holding one Bot is the normal, useful case;
   * "stop everything, I need the machine" has to be possible without visiting each Bot in turn. Scoped
   * to the caller, so it cannot be aimed at somebody else's fleet.
   */
  app.post("/control/release-all", requireUser, async (context) => {
    if (!botStore) return notFound(context);
    const released = await botStore.releaseAllForUser(context.var.actor.id);
    return context.json({ released });
  });

  /**
   * Forget this person's computer, or switch it off and leave it switchable.
   *
   * This used to be `/api/computers/<botId>/computers/{stop,reset}` on the per-Bot router, which is
   * not mounted any more — so the button in Settings answered 404 and, because the mutation's fallback
   * is a sentence about the computer rather than about the request, it read as "the computer could not
   * be reset" on a computer that was working.
   *
   * Both actions are per PERSON here, because the computer is. `stop` pauses, which is reversible and
   * costs nothing while paused; `reset` is the one that throws the machine away, and it is
   * deliberately the only path that does.
   */
  app.post("/computer/:action", requireUser, async (context) => {
    const action = context.req.param("action");
    if (action !== "stop" && action !== "reset") {
      return context.json(
        { error: `"${action}" is not something a computer can do.` },
        400,
      );
    }
    const scope = { key: context.var.actor.id, userId: context.var.actor.id };
    if (action === "stop") {
      await stopComputer?.(scope);
      return context.json({ status: "STOPPED" });
    }
    const removed = await removeComputer?.(context.var.actor.id);
    return context.json({ status: removed ? "DELETED" : "NONE" });
  });

  async function readOwnedBot(
    context: Context<{ Variables: AppVariables }>,
  ): Promise<BotComputer | null> {
    if (!botStore) return null;
    // The route pattern supplies `botId`; the type of a Hono context depends on the literal path it
    // was registered under, which this shared helper is not. Read it off the runtime value instead
    // of narrowing the type, and refuse anything that is not a string.
    const botId = (context.req.param("botId") as string | undefined) ?? "";
    if (!botId) return null;
    const row = await botStore.get(botId);
    // A Bot belonging to somebody else answers as not-found rather than as forbidden: the caller has
    // no business learning that an id exists.
    return row && row.userId === context.var.actor.id ? row : null;
  }

  const notFound = (context: Context<{ Variables: AppVariables }>) =>
    context.json({ error: "No such computer." }, 404);

  /**
   * What this person can watch, and what each Bot's desktop is doing.
   *
   * This route used to live on the old per-Bot computer router, which is mounted only when a
   * computer gateway exists. There is no gateway on the E2B desktop, so the whole router was
   * unmounted and the fleet answered 404 — which is why the Settings computer page rendered empty
   * and had nothing to say about why. Moved here, beside the desktop it describes, so it is mounted
   * exactly when there is a desktop to list.
   *
   * Every Bot is listed, whether or not it has a machine, because "not started yet" and "started"
   * are both answers a person watching a list needs, and a Bot silently missing looks like a bug.
   */
  app.get("/fleet", requireUser, async (context) => {
    const userId = context.var.actor.id;
    const bots = listBots ? await listBots(userId) : [];
    const perBot = botStore ? await botStore.listForUser(userId) : [];
    const byBot = new Map(perBot.map((row) => [row.botId, row]));

    return context.json({
      computers: bots.map((bot) => {
        const row = byBot.get(bot.id);
        return {
          botId: bot.id,
          name: bot.name,
          status: row?.status ?? "NONE",
          desiredStatus: row?.desiredStatus ?? "STOPPED",
          controlHolder: row?.controlHolder ?? "bot",
          // Whether this Bot has its own machine yet. False today for everyone, because nothing
          // provisions a per-Bot desktop yet; answered rather than omitted so the page can say
          // "not started" instead of leaving a card with no state on it.
          isolated: Boolean(row?.sandboxId),
        };
      }),
      isolation: "per-bot",
    });
  });

  /*
   * The ONE computer this person has, and what it has cost them.
   *
   * This replaces a `/fleet` route that listed a computer per Bot. It answered with rows from
   * `bot_computers`, which nothing has written since the per-Bot provisioner was removed, so it
   * reported every Bot as `status: "NONE"` and the Settings page rendered a list of computers that
   * did not exist — while the person's actual desktop sat right there, working, one row away.
   *
   * The shape is one computer and the hours behind it, because that is what a person opening this page
   * has two questions about: is it there, and how much of it is left. Read through a callback rather
   * than from a store so this router keeps no database handle and no billing logic.
   */
  app.get("/state", requireUser, async (context) => {
    if (!describeComputer) {
      return context.json({ error: "This deployment has no computer." }, 503);
    }
    const state = await describeComputer(context.var.actor.id);
    if (!state) {
      return context.json({ computer: null, reason: "no-computer-yet" }, 200);
    }
    return context.json(state);
  });

  return app;
}
