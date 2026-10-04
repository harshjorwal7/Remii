import type { Context, MiddlewareHandler } from "hono";
import { Hono } from "hono";
import {
  isMascotColorId,
  isMascotShapeId,
  type MascotChoice,
} from "../../../shared/mascot-ids";
import type { AuditEventType, AuditStore } from "../audit";
import { recordAuditEvent } from "../audit";
import type { AppVariables } from "../auth/guards";
import { canManageAgent } from "./profile-policy";
import {
  AgentNotFoundError,
  AgentNotManageableError,
  type AgentProfileStore,
  ManagedAgentUnavailableError,
  ProtectedAgentError,
} from "./profile-store";
import type {
  AgentActor,
  AgentProfile,
  CreateAgentInput,
} from "./profile-types";

type AgentInputParseResult =
  | { ok: true; value: CreateAgentInput }
  | { ok: false; error: string };

type AgentInputObject = {
  name?: unknown;
  title?: unknown;
  roleDescription?: unknown;
  visibility?: unknown;
  endpoint?: unknown;
  auth?: unknown;
  mascot?: unknown;
};

/**
 * Read a mascot out of a request body.
 *
 * Absent means **the key is left off the parsed value**, and that distinction is load-bearing rather
 * than tidy. `store.update` treats a missing `mascot` as "not touching it" and a present one as
 * "replace the row", so a parser that always returned the key would clear somebody's mascot on every
 * single save — and because the form sends the whole form, that would be every rename and every
 * endpoint change, which looks exactly like the mascot field silently not saving.
 *
 * A field the client sent is checked against the closed vocabulary and **rejected** if it is not in
 * it, which is the opposite of how every other field in this parser behaves — an unrecognised `name`
 * length or a bad endpoint is refused, but the point of refusing is that the person finds out. A
 * mascot id that was quietly dropped would render as a different mascot while the screen said it
 * saved, and there is no way for anybody to tell the difference by looking. An id from a newer build
 * is refused for the same reason: refused loudly beats rendered wrongly.
 *
 * Omitting a field inside `mascot` is not the same as sending a wrong one, so `{}` and
 * `{ color: "teal" }` are both accepted, and an omitted axis goes back to the seed. See
 * `profile-types.ts` on why that produces variety rather than one default.
 */
export function parseMascot(
  input: unknown,
):
  | { ok: true; value: Partial<MascotChoice> | undefined }
  | { ok: false; error: string } {
  if (input === undefined || input === null)
    return { ok: true, value: undefined };
  if (typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "Mascot must be an object." };
  }

  const raw = input as Record<string, unknown>;
  const mascot: Partial<MascotChoice> = {};

  if (raw.shape !== undefined && raw.shape !== null) {
    if (!isMascotShapeId(raw.shape)) {
      return {
        ok: false,
        error: `"${String(raw.shape)}" is not a mascot shape.`,
      };
    }
    mascot.shape = raw.shape;
  }
  if (raw.color !== undefined && raw.color !== null) {
    if (!isMascotColorId(raw.color)) {
      return {
        ok: false,
        error: `"${String(raw.color)}" is not a mascot colour.`,
      };
    }
    mascot.color = raw.color;
  }
  /*
   * An `expression` in the body is ignored rather than refused, and a warning goes out.
   *
   * It was a real axis until migration 0070 and a real column until the same change, so a client that
   * has not been rebuilt — an open tab from before the deploy, a script somebody wrote against the old
   * API — will still send one. Refusing that would fail the whole request over a field the user cannot
   * see and did not choose, and it would fail it on every retry, which is a worse outage than the one
   * the stale field can cause. Ignoring it means the save succeeds, the face follows the work, and
   * whoever is holding the stale client is told here rather than left wondering.
   *
   * The value is not validated. It is not going to be drawn, and a vocabulary check on a value nobody
   * reads would only be a way to reject a request for the sake of tidiness.
   */
  if (raw.expression !== undefined && raw.expression !== null) {
    console.warn(
      JSON.stringify({
        type: "mascot-expression-ignored",
        value: String(raw.expression),
        reason:
          "a mascot's expression follows the agent's work state and is no longer chosen; the value was dropped",
      }),
    );
  }

  return { ok: true, value: mascot };
}

/**
 * Parse and validate what a user typed into the agent form.
 *
 * There is nowhere to run a coworker here — every one of them runs on the engine this deployment
 * itself runs — so the body is only ever a name, a title, a role, and the mascot. An `endpoint` or an
 * `auth` sent by a stale client is refused rather than ignored: silently dropping it would let an old
 * build believe it had pointed a Bot somewhere, which is exactly the belief this feature exists to
 * remove.
 */
export function parseAgentInput(input: unknown): AgentInputParseResult {
  if (!isAgentInputObject(input)) {
    return { ok: false, error: "Agent input must be a JSON object." };
  }

  for (const refused of ["endpoint", "auth"] as const) {
    if (input[refused] !== undefined) {
      return {
        ok: false,
        error:
          refused === "endpoint"
            ? "Coworkers run on this deployment's own engine, so they cannot be given an address."
            : "Coworkers run on this deployment's own engine, so they need no key.",
      };
    }
  }

  const name = boundedText(
    input.name,
    80,
    "Name must be text between 1 and 80 characters.",
  );
  if (typeof name !== "string") return name;

  const title = boundedText(
    input.title,
    120,
    "Title must be text between 1 and 120 characters.",
  );
  if (typeof title !== "string") return title;

  const roleDescription = boundedText(
    input.roleDescription,
    1000,
    "Role description must be text between 1 and 1000 characters.",
  );
  if (typeof roleDescription !== "string") return roleDescription;

  if (typeof input.visibility !== "string") {
    return { ok: false, error: "Visibility must be private." };
  }
  const visibility = input.visibility.trim();
  // Strict per-user SaaS sandbox: public sharing is removed. Every coworker
  // is private to its owner; system templates are the only shared definitions
  // and they carry no user data.
  if (visibility !== "private") {
    return { ok: false, error: "Visibility must be private." };
  }

  const mascot = parseMascot(input.mascot);
  if (!mascot.ok) return mascot;

  return {
    ok: true,
    value: {
      name,
      title,
      roleDescription,
      visibility,
      // Omitted rather than set to null when the body said nothing, so "not touching it" survives
      // parsing. See the note on `parseMascot`.
      ...(mascot.value === undefined ? {} : { mascot: mascot.value }),
    },
  };
}

function isAgentInputObject(input: unknown): input is AgentInputObject {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

/**
 * The local development actor, which is not a row in `users`.
 *
 * The audit table has a foreign key to that table, so writing this id would fail the constraint and
 * lose the row entirely. Who it was is in the payload either way.
 */
const DEV_ACTOR_EMAIL = "dev@remii.local";

export function createAgentRoutes(
  store: AgentProfileStore,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
  /** Where a Bot's own refusal is recorded. Absent in tests that do not care about the trail. */
  auditStore?: AuditStore,
  /**
   * Which Bots a Bot may hand work to, for the screen that grants it.
   *
   * A named object rather than another positional argument: every parameter above this one is
   * optional, so a misplaced one typechecks and silently does nothing, and this list is already at
   * the length where that stops being hypothetical.
   *
   * Absent in a deployment with no plugin store, which is a deployment where no Bot may address any
   * other. The screen is then told the capability is off rather than shown a control that grants
   * nothing.
   */
  handoff?: {
    /** Whether the deployment's own caps leave the capability switched on at all. */
    enabled: boolean;
    /** The Bots this one may address today, read per call so a revoked grant stops showing. */
    reachableFrom: (agentId: string) => Promise<readonly string[]>;
    /**
     * Whether this Bot can be a grantee at all — the handing-on tool executes inside this
     * deployment's own run loop, so only a Bot that runs in it can be offered one. Exposed so the
     * screen can say that once, instead of letting every switch fail with the same refusal.
     * Optional so a caller without a plugin store answers "no" rather than crashing the read.
     */
    runsHere?: (agentId: string) => Promise<boolean | undefined>;
  },
) {
  const dto = (actor: AgentActor, agent: AgentProfile) =>
    agentDto(actor, agent);
  const routes = new Hono<{ Variables: AppVariables }>();

  /**
   * The Bot declined something, and says so.
   *
   * The audit trail records what a Bot did, decided by the gateway on the way to an action. A model
   * that refuses before calling any tool takes no action, so this records the attempted request.
   *
   * Self-reported, and said so in the row. The Bot calls this because its tool description tells it
   * to, so a model that declines without a tool call still writes nothing. This is evidence, not enforcement:
   * nothing is prevented by it, and a reader must not mistake an empty list for an untroubled Bot.
   */
  routes.post("/:agentId/declined", requireUser, async (context) => {
    const agentId = context.req.param("agentId");
    const body = (await context.req.json().catch(() => null)) as {
      reason?: unknown;
      request?: unknown;
    } | null;

    const reason = typeof body?.reason === "string" ? body.reason.trim() : "";
    if (!reason) {
      return context.json({ error: "A reason is required." }, 400);
    }

    /*
     * The same question every other route here asks first: is this a Bot the caller may reach?
     *
     * The row says "reportedBy: the Bot itself", and the Bot reports through the person's session,
     * so the trail's only way of knowing the report came from a Bot is that the person could have
     * been talking to that Bot. Without this check, any signed-in person could write a decline
     * against any id at all, a coworker they cannot see included, and an administrator reading the
     * trail would take it for something the Bot said. Not found rather than forbidden, as the store
     * answers everywhere else, so the check does not confirm which ids exist.
     */
    const agent = await store.get(context.var.actor, agentId);
    if (!agent) {
      return context.json({ error: "Agent not found." }, 404);
    }

    if (auditStore) {
      const actor = context.var.actor;
      await recordAuditEvent(auditStore, {
        eventType: "bot.declined",
        targetType: "agent",
        targetId: agentId,
        ...(actor?.id && actor.email !== DEV_ACTOR_EMAIL
          ? { actorUserId: actor.id }
          : {}),
        payload: {
          bot: agentId,
          actor: actor?.email ?? "unknown",
          reason: reason.slice(0, 500),
          // What it was asked, in the Bot's own words and only if it offered them. Truncated for the
          // same reason every other payload here is: a trail is not a transcript.
          ...(typeof body?.request === "string" && body.request.trim()
            ? { request: body.request.trim().slice(0, 500) }
            : {}),
          reportedBy: "the Bot itself",
        },
      });
    }

    return context.json({ recorded: true });
  });

  routes.get("/", requireUser, async (context) => {
    try {
      const hidden = context.req.query("hidden") === "true";
      const agents = await store.list(context.var.actor, hidden);
      return context.json({
        agents: agents.map((agent) => dto(context.var.actor, agent)),
      });
    } catch (error) {
      return mapStoreError(context, error);
    }
  });

  routes.get("/:agentId", requireUser, async (context) => {
    // A whitespace id would reach the store query and answer 500 on some backends instead of a
    // 400 for a malformed call. Existence stays a 404; shape is checked here.
    if (!context.req.param("agentId").trim()) {
      return context.json({ error: "A Bot id is required." }, 400);
    }
    try {
      const agent = await store.get(
        context.var.actor,
        context.req.param("agentId"),
      );
      if (!agent) {
        return context.json({ error: "Agent not found." }, 404);
      }
      return context.json({ agent: dto(context.var.actor, agent) });
    } catch (error) {
      return mapStoreError(context, error);
    }
  });

  /*
   * Record something that changed a Bot.
   *
   * One helper rather than eight copies, because the eight routes below all answer the same question
   * and the payload has to be the same shape for a reader filtering the trail.
   *
   * Never fatal. The change is already made and the caller has been told so; a trail that is briefly
   * unavailable is not a reason to report a failure that did not happen.
   */
  const record = async (
    context: Context<{ Variables: AppVariables }>,
    eventType: Extract<AuditEventType, `bot.${string}`>,
    agentId: string,
    payload: Record<string, unknown> = {},
  ): Promise<void> => {
    if (!auditStore) return;
    const actor = context.var.actor;
    try {
      await recordAuditEvent(auditStore, {
        eventType,
        targetType: "agent",
        targetId: agentId,
        ...(actor?.id && actor.email !== DEV_ACTOR_EMAIL
          ? { actorUserId: actor.id }
          : {}),
        payload: { bot: agentId, actor: actor?.email ?? "unknown", ...payload },
      });
    } catch (error) {
      console.error(
        JSON.stringify({
          type: "bot-audit-write-failed",
          eventType,
          agentId,
          error: String(error),
        }),
      );
    }
  };

  routes.post("/", requireUser, async (context) => {
    // Malformed JSON is a recoverable client-input error and is validated by the same parser.
    const parsed = parseAgentInput(await context.req.json().catch(() => null));
    if (!parsed.ok) return context.json({ error: parsed.error }, 400);

    try {
      /*
       * The role description is what this coworker runs on.
       *
       * It is passed on every create rather than only when no endpoint was given, because there is no
       * longer a "given" case: this deployment has one engine and every coworker runs on it. The
       * store decides what to write — the deployment's own AG-UI endpoint when it has one, and a
       * `built_in` row carrying this prompt when it does not.
       */
      const agent = await store.create(context.var.actor, {
        ...parsed.value,
        systemPrompt: parsed.value.roleDescription,
      });
      /*
       * And who may reach it. Strict per-user SaaS sandbox: every coworker is
       * private to its owner (`accessFilter` admits only the owner's rows plus
       * deployment system templates), and `canRunAgent` is `canAccessAgent`,
       * so nothing one user makes is ever reachable by another. A row that
       * cannot say which it was cannot reconstruct who could use this
       * coworker at the time.
       */
      await record(context, "bot.created", agent.id, {
        name: parsed.value.name,
        visibility: parsed.value.visibility,
      });
      return context.json({ agent: dto(context.var.actor, agent) }, 201);
    } catch (error) {
      return mapStoreError(context, error);
    }
  });

  routes.patch("/:agentId", requireUser, async (context) => {
    // Malformed JSON is a recoverable client-input error and is validated by the same parser.
    const parsed = parseAgentInput(await context.req.json().catch(() => null));
    if (!parsed.ok) return context.json({ error: parsed.error }, 400);

    try {
      const agent = await store.update(
        context.var.actor,
        context.req.param("agentId"),
        parsed.value,
      );
      /*
       * What changed, not the new values.
       *
       * `visibility` is carried the way `name` is — on every row, whether or not this edit moved it —
       * because it is the dangerous edit and the route has no before to compare against.
       * Public admits every signed-in person to this coworker, and `canRunAgent` is `canAccessAgent`,
       * so it hands them the right to act as it and spend what it was granted. Without the value on
       * each row, an edit that opened a coworker to the whole deployment is byte-identical to one
       * that corrected its title, and the trail cannot say when it was opened or by whom. Recorded on
       * every row rather than only on the row that changed it, so reading the trail forward tells you
       * what was reachable at any point, which is what an incident asks.
       */
      await record(context, "bot.updated", agent.id, {
        name: parsed.value.name,
        visibility: parsed.value.visibility,
      });
      return context.json({ agent: dto(context.var.actor, agent) });
    } catch (error) {
      return mapStoreError(context, error);
    }
  });

  routes.post("/:agentId/duplicate", requireUser, async (context) => {
    if (!context.req.param("agentId").trim()) {
      return context.json({ error: "A Bot id is required." }, 400);
    }
    try {
      const agent = await store.duplicate(
        context.var.actor,
        context.req.param("agentId"),
      );
      await record(context, "bot.duplicated", agent.id, {
        copiedFrom: context.req.param("agentId"),
      });
      return context.json({ agent: dto(context.var.actor, agent) }, 201);
    } catch (error) {
      return mapStoreError(context, error);
    }
  });

  routes.post("/:agentId/hide", requireUser, async (context) => {
    try {
      await store.setHidden(
        context.var.actor,
        context.req.param("agentId"),
        true,
      );
      await record(context, "bot.hidden", context.req.param("agentId"));
      return context.body(null, 204);
    } catch (error) {
      return mapStoreError(context, error);
    }
  });

  routes.post("/:agentId/unhide", requireUser, async (context) => {
    try {
      await store.setHidden(
        context.var.actor,
        context.req.param("agentId"),
        false,
      );
      await record(context, "bot.unhidden", context.req.param("agentId"));
      return context.body(null, 204);
    } catch (error) {
      return mapStoreError(context, error);
    }
  });

  /*
   * Issue this agent its callback credential, and show it once.
   *
   * A POST because it writes and because it replaces: calling it again rotates, which is how a leaked
   * token is retired. The token is in the response and nowhere else, ever again, and it is not written
   * to the audit payload either: a trail that records credentials is a credential store with worse
   * access control.
   */
  routes.post("/:agentId/callback-token", requireUser, async (context) => {
    try {
      const token = await store.issueCallbackToken(
        context.var.actor,
        context.req.param("agentId"),
      );
      // That one was issued, never what it is. A trail that records credentials is a credential
      // store with worse access control.
      await record(
        context,
        "bot.callback_token_issued",
        context.req.param("agentId"),
      );
      return context.json({ token }, 201);
    } catch (error) {
      return mapStoreError(context, error);
    }
  });

  /** Take it away. The agent may still hold a conversation; it may not reach anything outside one. */
  routes.delete("/:agentId/callback-token", requireUser, async (context) => {
    try {
      await store.revokeCallbackToken(
        context.var.actor,
        context.req.param("agentId"),
      );
      await record(
        context,
        "bot.callback_token_revoked",
        context.req.param("agentId"),
      );
      return context.body(null, 204);
    } catch (error) {
      return mapStoreError(context, error);
    }
  });

  routes.delete("/:agentId", requireUser, async (context) => {
    if (!context.req.param("agentId").trim()) {
      return context.json({ error: "A Bot id is required." }, 400);
    }
    try {
      await store.softDelete(context.var.actor, context.req.param("agentId"));
      await record(context, "bot.deleted", context.req.param("agentId"));
      return context.body(null, 204);
    } catch (error) {
      return mapStoreError(context, error);
    }
  });

  /**
   * Which Bots this Bot may hand work to.
   *
   * On the Bot's own screen rather than under the connector catalogue, because it is a fact about
   * this Bot and not about a vendor: the catalogue's entries have a fixed list of tools, and the
   * Bots a deployment has are whatever somebody made.
   *
   * `enabled` is reported separately from the grants, because the two fail differently. A grant with
   * the capability switched off is a row in the database that will never be read, and a screen that
   * offered it without saying so would be a switch wired to nothing.
   */
  routes.get("/:agentId/handoff", requireUser, async (context) => {
    const agentId = context.req.param("agentId");
    if (!agentId.trim()) {
      return context.json({ error: "A Bot id is required." }, 400);
    }
    try {
      // Asked of the store, so a Bot somebody may not see is "not found" here as everywhere else,
      // rather than a list of who it can reach.
      const agent = await store.get(context.var.actor, agentId);
      if (!agent) return context.json({ error: "Agent not found." }, 404);
      return context.json({
        handoff: {
          enabled: handoff?.enabled ?? false,
          // Granting is the owner's: nobody may wire another person's Bot into their own.
          canGrant: true,
          reachable: handoff ? await handoff.reachableFrom(agentId) : [],
          // Whether this Bot can hold such a grant at all; the write path refuses one that cannot,
          // and the screen should say so before a person flips switches that can only bounce.
          grantable: handoff?.runsHere
            ? ((await handoff.runsHere(agentId)) ?? false)
            : false,
        },
      });
    } catch (error) {
      return mapStoreError(context, error);
    }
  });

  return routes;
}

function boundedText(
  value: unknown,
  maximumLength: number,
  error: string,
): string | { ok: false; error: string } {
  if (typeof value !== "string") return { ok: false, error };
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= maximumLength
    ? trimmed
    : { ok: false, error };
}

function agentDto(actor: AgentActor, agent: AgentProfile) {
  return {
    id: agent.id,
    name: agent.name,
    title: agent.title,
    roleDescription: agent.roleDescription,
    avatarSeed: agent.avatarSeed,
    // Null when nobody has chosen one, which the client resolves from `avatarSeed` rather than
    // sending a guess back. Round-tripping a resolved mascot into this field on the next save would
    // quietly convert every seeded agent into a chosen one, and the person's "reset to random" would
    // stop working the first time they edited the name.
    mascot: agent.mascot,
    pausedAt: agent.pausedAt,
    pausedReason: agent.pausedReason,
    visibility: agent.visibility,
    hidden: agent.hidden,
    systemOwned: agent.systemOwned,
    canManage: canManageAgent(actor, agent),
    // Ownership, kept separate from permission. `canManage` is also true for an administrator on
    // another user's coworker, so a roster that split "mine" on it would file other people's work
    // under yours, and only for administrators, who are the least likely to notice.
    mine: agent.ownerUserId === actor.id,
    isSystemTemplate: agent.isSystemTemplate,
  };
}

function mapStoreError(context: Context, error: unknown): Response {
  if (error instanceof AgentNotFoundError) {
    return context.json({ error: "Agent not found." }, 404);
  }
  if (error instanceof AgentNotManageableError) {
    return context.json(
      { error: "You do not have permission to manage this agent." },
      403,
    );
  }
  if (error instanceof ProtectedAgentError) {
    return context.json({ error: "System-owned agents are protected." }, 403);
  }
  if (error instanceof ManagedAgentUnavailableError) {
    return context.json({ error: error.message }, 400);
  }
  throw error;
}
