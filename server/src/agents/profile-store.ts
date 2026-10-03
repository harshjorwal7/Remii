import { and, eq, isNotNull, isNull, or } from "drizzle-orm";
import type { Database } from "../db/client";
import {
  agentPreferences,
  agentProfiles,
  agents,
  deploymentPackages,
} from "../db/schema";
import {
  hashCallbackToken,
  mintCallbackToken,
  sameToken,
} from "./callback-token";
import { mascotColumnValues, readMascot } from "./mascot";
import { canManageAgent } from "./profile-policy";
import type {
  AgentActor,
  AgentProfile,
  CreateAgentInput,
} from "./profile-types";
import { readDelegationOnly } from "./supervision";

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type DatabaseExecutor = Pick<Database, "select"> | Pick<Transaction, "select">;

/** Something that can read profiles: the pool, or a caller's open transaction. */
export type ProfileReadExecutor = DatabaseExecutor;

export type AgentProfileStore = {
  list(actor: AgentActor, hidden?: boolean): Promise<AgentProfile[]>;
  get(actor: AgentActor, id: string): Promise<AgentProfile | null>;
  /**
   * `get`, but on the caller's own transaction and holding the profile against deletion until that
   * transaction ends.
   *
   * A caller that writes rows referencing an agent has to validate it here rather than through
   * `get`. `get` borrows a second pooled connection, which deadlocks the caller's transaction once
   * every connection is held by one, and reads an unlocked snapshot, so a deletion committing
   * between the check and the insert leaves rows pointing at an agent that no longer runs.
   */
  getWithin(
    executor: ProfileReadExecutor,
    actor: AgentActor,
    id: string,
  ): Promise<AgentProfile | null>;
  create(
    actor: AgentActor,
    input: CreateAgentInput & {
      /**
       * The standing instruction for a coworker with nowhere else to run.
       *
       * Only consulted when there is neither an endpoint nor a Bot in the box, and it is what makes
       * that a `built_in` coworker rather than a refusal. `POST /api/agents` never sends it — the
       * form has no such field — so a hand-made Bot on a deployment without a managed agent is
       * refused exactly as it is today.
       *
       * Not on `CreateAgentInput`, so `update` cannot take it: changing an existing Bot's type is a
       * different act with different consequences, and this is the creation path.
       */
      systemPrompt?: string;
    },
  ): Promise<AgentProfile>;
  update(
    actor: AgentActor,
    id: string,
    input: CreateAgentInput,
  ): Promise<AgentProfile>;
  duplicate(actor: AgentActor, id: string): Promise<AgentProfile>;
  setHidden(actor: AgentActor, id: string, hidden: boolean): Promise<void>;
  softDelete(actor: AgentActor, id: string): Promise<void>;
  /**
   * Issue this agent a credential for calling tools back, and return it once.
   *
   * Returned rather than stored: only the hash is kept, so this is the one moment the token exists in
   * a readable form. Calling it again replaces the old one, which is how rotation works and how a
   * leaked token is retired.
   */
  issueCallbackToken(actor: AgentActor, id: string): Promise<string>;
  /** Take the credential away. The agent may talk, and may no longer call anything back. */
  revokeCallbackToken(actor: AgentActor, id: string): Promise<void>;
  /**
   * Which agent holds this token, if any.
   *
   * By hash, because that is all this side keeps. Not scoped to an actor: the caller is a machine
   * presenting a credential, and the credential is the whole of its claim.
   */
  agentForCallbackToken(hash: string): Promise<{ id: string } | null>;
  setOnAgentCreated?(callback: (agentId: string) => Promise<void>): void;
};

export class AgentNotFoundError extends Error {
  constructor(id: string) {
    super(`Agent ${id} was not found.`);
    this.name = "AgentNotFoundError";
  }
}

export class AgentNotManageableError extends Error {
  constructor(id: string) {
    super(`Agent ${id} cannot be managed by this actor.`);
    this.name = "AgentNotManageableError";
  }
}

export class ProtectedAgentError extends Error {
  constructor(id: string) {
    super(`Agent ${id} is protected.`);
    this.name = "ProtectedAgentError";
  }
}

export class ManagedAgentUnavailableError extends Error {
  constructor() {
    super(
      "This deployment has no engine to run coworkers on. Ask whoever runs it to configure one.",
    );
    this.name = "ManagedAgentUnavailableError";
  }
}

const joinedProjection = {
  id: agents.id,
  name: agents.name,
  title: agentProfiles.title,
  roleDescription: agentProfiles.roleDescription,
  avatarSeed: agentProfiles.avatarSeed,
  mascotShape: agentProfiles.mascotShape,
  mascotColor: agentProfiles.mascotColor,
  visibility: agentProfiles.visibility,
  ownerUserId: agentProfiles.ownerUserId,
  packageId: deploymentPackages.id,
  hiddenAt: agentPreferences.hiddenAt,
  deletedAt: agentProfiles.deletedAt,
  /* The hash, only so a surface can say whether one exists. It never leaves this module. */
  callbackTokenHash: agentProfiles.callbackTokenHash,
  configuration: agents.configuration,
  override: agents.override,
  isSystemTemplate: agents.isSystemTemplate,
};

function joinedProfiles(executor: DatabaseExecutor, actor: AgentActor) {
  return executor
    .select(joinedProjection)
    .from(agents)
    .innerJoin(agentProfiles, eq(agentProfiles.agentId, agents.id))
    .leftJoin(
      agentPreferences,
      and(
        eq(agentPreferences.agentId, agents.id),
        eq(agentPreferences.userId, actor.id),
      ),
    )
    .leftJoin(deploymentPackages, eq(deploymentPackages.id, agents.packageId));
}

function accessFilter(actor: AgentActor) {
  // Strict per-user SaaS: no public sharing and no administrator override.
  // Owners see their own coworkers plus deployment system templates
  // (definitions only — computers, workspaces and connections stay per-user).
  return or(
    eq(agentProfiles.ownerUserId, actor.id),
    isNull(agentProfiles.ownerUserId),
  );
}

function mapProfile(
  row: Awaited<
    ReturnType<ReturnType<typeof joinedProfiles>["execute"]>
  >[number],
): AgentProfile {
  return {
    id: row.id,
    name: row.name,
    title: row.title,
    roleDescription: row.roleDescription,
    avatarSeed: row.avatarSeed,
    mascot: readMascot(row),
    // Strict per-user SaaS sandbox: the database enum still carries "public"
    // on old rows, but nothing above this line admits such a row for another
    // user, and the surface never offers it. Coerce here so no "public"
    // value ever leaves the server.
    visibility: "private" as const,
    ownerUserId: row.ownerUserId,
    isSystemTemplate: Boolean(row.isSystemTemplate),
    // A supervisor is one boolean inside the override blob, and only an exact
    // `true` counts. Anything else — a string, a number, a key that means
    // something else to a later version — is a worker, which is the safe side
    // to fall on: a worker that keeps its tools behaves exactly as it did.
    delegationOnly: readDelegationOnly(row.override),
    systemOwned: row.packageId !== null,
    hidden: row.hiddenAt !== null,
    deletedAt: row.deletedAt,
    endpoint: endpointOf(row.configuration),
  };
}

/**
 * The AG-UI address this coworker runs on, read back out of its stored configuration.
 *
 * Needed so an edit does not destroy it. The edit form is the same form as create, so without the
 * current endpoint to fill it with, saving a change of title would submit an empty endpoint and
 * convert an external agent back into the built-in one. That failure is silent and total: the Bot
 * keeps working, so nothing looks broken, and it is simply no longer their agent.
 */
function endpointOf(configuration: unknown): string | null {
  if (!configuration || typeof configuration !== "object") return null;
  const endpoint = (configuration as { endpoint?: unknown }).endpoint;
  return typeof endpoint === "string" ? endpoint : null;
}

/** Which agent on a Mastra server this Bot means, when the row names one. */
function remoteAgentIdOf(configuration: unknown): string | null {
  if (!configuration || typeof configuration !== "object") return null;
  const named = (configuration as { remoteAgentId?: unknown }).remoteAgentId;
  return typeof named === "string" && named.length > 0 ? named : null;
}

/**
 * The instruction a Bot in the box runs on, read back out of its stored configuration.
 *
 * The mirror of {@link endpointOf}, and needed for the same reason: a copy has to be made of what
 * the original actually was, and for a `built_in` coworker the prompt IS the coworker. Trimmed and
 * required to be non-empty, matching `registeredAgentFromRow`, which will not build a Bot from a
 * blank one either.
 */
function systemPromptOf(configuration: unknown): string | null {
  if (!configuration || typeof configuration !== "object") return null;
  const prompt = (configuration as { systemPrompt?: unknown }).systemPrompt;
  if (typeof prompt !== "string") return null;
  const trimmed = prompt.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** What a coworker is, and what it runs on: the two `agents` columns a copy has to reproduce. */
export type AgentRun = {
  type: "built_in" | "remote_ag_ui" | "remote_mastra";
  configuration: Record<string, unknown>;
};

/**
 * What a duplicate runs on, decided from what the original ran on.
 *
 * WHY THIS IS NOT JUST THE ENDPOINT. Duplicate used to rebuild the copy from `source.endpoint` alone
 * and write `type: "remote_ag_ui"` flat. #328 fixed the half of that a coworker with its own endpoint
 * saw. The other half is a coworker that has no endpoint because it is not supposed to have one: a
 * `built_in` Bot's configuration is `{ systemPrompt }`, so the endpoint read came back null, the copy
 * fell through to the managed Bot, and the prompt was dropped on the floor.
 *
 * That copy is the failure this repository already has a paragraph about. It looks identical on every
 * screen and its whole instruction becomes `standingRoleMessage` — see the note above that function
 * in `copilot.ts`, which names the compliance Bot that answered a filing question with invented
 * thresholds because one sentence of role description was all that reached it. The default tenant
 * package ships two `built_in` coworkers, and one of them, `Knowledge`, is a careful
 * do-not-fabricate instruction. Copy it and you get a coworker with the name, the title, the avatar,
 * and none of that.
 *
 * The type is carried too, not only the configuration. A copy written as `remote_ag_ui` also cannot
 * be granted handoff for the rest of its life: `agentRunsHere` and `botsReachableFrom` both key on
 * `agents.type == "built_in"`, so the original may hand work on and its copy silently may not.
 *
 * `null` means there is nothing to run this copy on, which the caller turns into
 * {@link ManagedAgentUnavailableError}. That can now only happen for a source that had neither an
 * endpoint nor a prompt on a deployment with no managed Bot — never for a `built_in` source, which
 * brings its own instruction and needs no managed Bot to fall back to.
 *
 * `auth` is deliberately not carried: it is a reference into the vault, and two coworkers sharing one
 * credential would mean rotating either one's key silently changed the other's.
 */
export function runForDuplicate(
  source: {
    type: "built_in" | "remote_ag_ui" | "remote_mastra";
    configuration: unknown;
  },
  managed: Record<string, unknown> | undefined,
): AgentRun | null {
  const systemPrompt = systemPromptOf(source.configuration);
  if (source.type === "built_in" && systemPrompt) {
    return { type: "built_in", configuration: { systemPrompt } };
  }

  const endpoint = endpointOf(source.configuration);
  if (endpoint) {
    /*
     * The copy is dialled the way the original was, and that is not cosmetic. A Mastra endpoint
     * speaks Mastra's client protocol and has no AG-UI route, so a duplicate written as
     * `remote_ag_ui` would carry the right address and be unable to say anything to it. The Bot
     * would appear, accept a grant, and answer nothing.
     *
     * Which agent on that server comes with it for the same reason: a Mastra endpoint is a roster,
     * and a copy that forgets the name falls back to a different agent, or refuses. See
     * `pickFromRoster`.
     */
    if (source.type === "remote_mastra") {
      const remoteAgentId = remoteAgentIdOf(source.configuration);
      return {
        type: "remote_mastra",
        configuration: remoteAgentId
          ? { endpoint, remoteAgentId }
          : { endpoint },
      };
    }
    return { type: "remote_ag_ui", configuration: { endpoint } };
  }

  return managed ? { type: "remote_ag_ui", configuration: managed } : null;
}

async function findAccessibleProfile(
  executor: DatabaseExecutor,
  actor: AgentActor,
  id: string,
): Promise<AgentProfile | null> {
  const [row] = await joinedProfiles(executor, actor).where(
    and(
      eq(agents.id, id),
      isNull(agentProfiles.deletedAt),
      accessFilter(actor),
    ),
  );
  return row ? mapProfile(row) : null;
}

async function lockProfileMutationRows(executor: DatabaseExecutor, id: string) {
  await executor
    .select({ id: agents.id })
    .from(agents)
    .where(eq(agents.id, id))
    .for("update");
  await executor
    .select({ agentId: agentProfiles.agentId })
    .from(agentProfiles)
    .where(eq(agentProfiles.agentId, id))
    .for("update");
}

/**
 * Share-lock a profile so it stays readable to concurrent callers but cannot be deleted or renamed
 * until this transaction ends. `lockProfileMutationRows` takes the exclusive counterpart, so a
 * deletion racing a reference blocks here instead of committing underneath it.
 */
async function lockProfileReadRow(executor: DatabaseExecutor, id: string) {
  await executor
    .select({ agentId: agentProfiles.agentId })
    .from(agentProfiles)
    .where(eq(agentProfiles.agentId, id))
    .for("share");
}

function requireManageable(actor: AgentActor, profile: AgentProfile) {
  if (profile.systemOwned) throw new ProtectedAgentError(profile.id);
  if (!canManageAgent(actor, profile)) {
    throw new AgentNotManageableError(profile.id);
  }
}

function newAgentId() {
  return `agent_${crypto.randomUUID()}`;
}

/**
 * Which agent a token belongs to.
 *
 * Selected by hash and then compared in constant time. The lookup alone would be enough to identify
 * the row, and the comparison is what keeps a timing difference from confirming a partial guess
 * against an index.
 */
async function findByTokenHash(
  database: Database,
  hash: string,
): Promise<{ id: string } | null> {
  const rows = await database
    .select({
      agentId: agentProfiles.agentId,
      hash: agentProfiles.callbackTokenHash,
    })
    .from(agentProfiles)
    .where(
      and(
        eq(agentProfiles.callbackTokenHash, hash),
        isNull(agentProfiles.deletedAt),
      ),
    )
    .limit(1);

  const row = rows[0];
  if (!row?.hash) return null;
  return sameToken(row.hash, hash) ? { id: row.agentId } : null;
}

export function createAgentProfileStore(
  database: Database,
  managedAgentAgUiUrl: URL | undefined,
): AgentProfileStore {
  const managedConfiguration = managedAgentAgUiUrl
    ? { endpoint: managedAgentAgUiUrl.toString() }
    : undefined;

  let onAgentCreatedCallback: ((agentId: string) => Promise<void>) | undefined;

  return {
    setOnAgentCreated(callback: (agentId: string) => Promise<void>) {
      onAgentCreatedCallback = callback;
    },

    async list(actor, hidden = false) {
      const rows = await joinedProfiles(database, actor).where(
        and(
          isNull(agentProfiles.deletedAt),
          accessFilter(actor),
          hidden
            ? isNotNull(agentPreferences.hiddenAt)
            : isNull(agentPreferences.hiddenAt),
        ),
      );
      return rows.map(mapProfile);
    },

    get(actor, id) {
      return findAccessibleProfile(database, actor, id);
    },

    async getWithin(executor, actor, id) {
      await lockProfileReadRow(executor, id);
      return findAccessibleProfile(executor, actor, id);
    },

    async create(actor, input) {
      const profile = await database.transaction(async (transaction) => {
        if (!actor?.id) {
          throw new Error("ownerUserId is required to create an agent.");
        }
        const id = newAgentId();
        const systemPrompt = input.systemPrompt?.trim();
        // One shape for both branches below, so marking a Bot a supervisor
        // cannot depend on which kind of Bot it is. Null when it is not one,
        // which leaves the column exactly as an ordinary worker has it.
        const override =
          input.delegationOnly === true ? { delegationOnly: true } : null;
        if (managedConfiguration) {
          /*
           * The deployment's own Bot, which is the only place a coworker made here can run.
           *
           * Nobody supplies an address: the create form has no such field and the route refuses one,
           * so every coworker a person makes is reached the same way — over this deployment's own
           * AG-UI endpoint, on loopback or inside its own network. The Bot that ships in the box and
           * the harness chosen at setup are registered this same way; see `tenant-package.ts`.
           */
          await transaction.insert(agents).values({
            id,
            ownerUserId: actor.id,
            isSystemTemplate: false,
            name: input.name,
            override,
            type: "remote_ag_ui",
            configuration: managedConfiguration,
          });
        } else if (systemPrompt) {
          /*
           * Nowhere to send it, so it runs here.
           *
           * This is the shape Remii (Chief of Staff) and Knowledge already have, and the shape
           * `registeredAgentFromRow` reads: `built_in` plus a non-empty `configuration.systemPrompt`.
           * A key is deliberately not written on this branch — a key authenticates to an address and
           * this coworker has none, so storing one would leave a live credential in the vault that
           * nothing can ever present.
           */
          await transaction.insert(agents).values({
            id,
            ownerUserId: actor.id,
            isSystemTemplate: false,
            name: input.name,
            override,
            type: "built_in",
            configuration: { systemPrompt },
          });
        } else {
          /*
           * No address, no Bot in the box, and no instruction to run on. There is nothing to create:
           * a `built_in` row with an empty prompt is a coworker `registeredAgentFromRow` drops on
           * the floor, and the Bot would exist on every screen while answering nobody.
           */
          throw new ManagedAgentUnavailableError();
        }
        await transaction.insert(agentProfiles).values({
          agentId: id,
          ownerUserId: actor.id,
          isSystemTemplate: false,
          title: input.title,
          roleDescription: input.roleDescription,
          avatarSeed: id,
          // Null for a coworker nobody has dressed yet, which is most of them. The client resolves
          // that from `avatarSeed`, so a new agent lands on a stable mascot without the row having to
          // guess one and without the guess becoming the person's choice the moment they save.
          ...mascotColumnValues(input.mascot),
          visibility: input.visibility,
        });

        const profile = await findAccessibleProfile(transaction, actor, id);
        if (!profile) throw new AgentNotFoundError(id);
        return profile;
      });

      await onAgentCreatedCallback?.(profile.id).catch((err) => {
        console.warn("onAgentCreated hook failed for agent", profile.id, err);
      });

      return profile;
    },

    update(actor, id, input) {
      return database.transaction(
        async (transaction) => {
          await lockProfileMutationRows(transaction, id);
          const profile = await findAccessibleProfile(transaction, actor, id);
          if (!profile) throw new AgentNotFoundError(id);
          requireManageable(actor, profile);

          const updatedAt = new Date();
          const [row] = await transaction
            .select({
              configuration: agents.configuration,
              override: agents.override,
              type: agents.type,
            })
            .from(agents)
            .where(eq(agents.id, id))
            .limit(1);
          const previous = (row?.configuration ?? {}) as Record<
            string,
            unknown
          >;
          /**
           * A coworker that runs here runs on its role description, so editing one has to move both.
           *
           * `create` writes the role description into `configuration.systemPrompt` for a coworker
           * with no address, and that prompt is the ONLY instruction such a coworker ever gets:
           * `registeredAgentFromRow` gives a `built_in` agent its `systemPrompt` and no standing
           * role message, so `agentProfiles.roleDescription` never reaches it. Left out of this
           * merge, an edit wrote the new text to the profile every screen reads and left the Bot
           * running on the original — permanently, with nothing anywhere to say so.
           *
           * Only for `built_in`, and that matters. A Bot reached over AG-UI has no `systemPrompt` and
           * must not acquire one — its instruction travels as the standing role message instead — and
           * the tenant package's Bots, whose `system_prompt` is deliberately not their
           * `role_description`, cannot reach this code at all: `requireManageable` above throws
           * `ProtectedAgentError` for anything the package owns.
           *
           * Nothing else in the configuration is touched. The address a coworker runs on is the
           * deployment's own and is not a person's to move: an edit that rewrote it would let a
           * saved form point a Bot anywhere, which is the whole thing this feature no longer allows.
           */
          const configuration = {
            ...previous,
            ...(row?.type === "built_in"
              ? { systemPrompt: input.roleDescription }
              : {}),
          };

          /*
           * Supervisor or worker, toggled. Absent from the input means the
           * caller is not touching it, the same reading `auth` takes above, so
           * an edit of the name cannot quietly strip a Bot of its role. Any
           * other keys already in the blob are carried over, because this
           * column is shared and a future reader of some other key must not
           * find it deleted by an unrelated save.
           */
          const override =
            input.delegationOnly === undefined
              ? (row?.override ?? null)
              : {
                  ...(row?.override && typeof row.override === "object"
                    ? (row.override as Record<string, unknown>)
                    : {}),
                  delegationOnly: input.delegationOnly,
                };

          await transaction
            .update(agents)
            .set({ name: input.name, configuration, override, updatedAt })
            .where(eq(agents.id, id));
          await transaction
            .update(agentProfiles)
            .set({
              title: input.title,
              roleDescription: input.roleDescription,
              visibility: input.visibility,
              /*
               * A mascot the caller did not mention is left alone, exactly as `auth` and
               * `delegationOnly` are above and for the same reason: the edit form sends the whole
               * form, and a row that overwrote the mascot on every save would mean that fixing a typo
               * in a name silently reset somebody's coworker's face.
               *
               * A mascot that IS mentioned replaces the row outright, so an omitted axis goes back to
               * the seed rather than keeping a stale choice — otherwise clearing one colour would be
               * impossible without a separate "reset" endpoint.
               */
              ...(input.mascot === undefined
                ? {}
                : mascotColumnValues(input.mascot)),
              updatedAt,
            })
            .where(eq(agentProfiles.agentId, id));

          const updated = await findAccessibleProfile(transaction, actor, id);
          if (!updated) throw new AgentNotFoundError(id);
          return updated;
        },
        { isolationLevel: "read committed" },
      );
    },

    async duplicate(actor, id) {
      const duplicate = await database.transaction(async (transaction) => {
        const source = await findAccessibleProfile(transaction, actor, id);
        if (!source) throw new AgentNotFoundError(id);

        /*
         * The stored row, because a profile does not carry what a copy has to reproduce.
         *
         * `AgentProfile` projects `endpoint` out of the configuration and nothing else, which is all
         * an edit form needs and half of what this needs: a `built_in` coworker has no endpoint and
         * a prompt instead. Read here rather than widened into the profile, so the DTO every surface
         * gets does not start carrying a Bot's instructions. Inside the transaction, and after the
         * access check, so this cannot read a row the caller may not see.
         */
        const [stored] = await transaction
          .select({ type: agents.type, configuration: agents.configuration })
          .from(agents)
          .where(eq(agents.id, id))
          .limit(1);
        if (!stored) throw new AgentNotFoundError(id);

        // `auth` is a vault reference and is deliberately not carried: see `runForDuplicate`.
        const run = runForDuplicate(stored, managedConfiguration);
        // After the source read, so a source that brings its own endpoint or its own prompt needs no
        // managed Bot to fall back to.
        if (!run) {
          throw new ManagedAgentUnavailableError();
        }
        if (!actor?.id) {
          throw new Error("ownerUserId is required to duplicate an agent.");
        }
        const duplicateId = newAgentId();
        await transaction.insert(agents).values({
          id: duplicateId,
          ownerUserId: actor.id,
          isSystemTemplate: false,
          name: source.name,
          type: run.type,
          configuration: run.configuration,
        });
        await transaction.insert(agentProfiles).values({
          agentId: duplicateId,
          ownerUserId: actor.id,
          isSystemTemplate: false,
          title: source.title,
          roleDescription: source.roleDescription,
          avatarSeed: source.avatarSeed,
          // Copied, for the same reason `avatarSeed` is: a duplicate is meant to look like the thing
          // it was duplicated from, and a coworker that came back wearing a different face would be
          // indistinguishable from a bug. A source with no chosen mascot carries no choice over, so
          // both keep seeding from the same copied `avatarSeed` and match exactly.
          ...mascotColumnValues(source.mascot),
          visibility: "private",
        });

        const duplicate = await findAccessibleProfile(
          transaction,
          actor,
          duplicateId,
        );
        if (!duplicate) throw new AgentNotFoundError(duplicateId);
        return duplicate;
      });

      await onAgentCreatedCallback?.(duplicate.id).catch((err) => {
        console.warn(
          "onAgentCreated hook failed for duplicate agent",
          duplicate.id,
          err,
        );
      });

      return duplicate;
    },

    setHidden(actor, id, hidden) {
      return database.transaction(async (transaction) => {
        const profile = await findAccessibleProfile(transaction, actor, id);
        if (!profile) throw new AgentNotFoundError(id);

        await transaction
          .insert(agentPreferences)
          .values({
            userId: actor.id,
            agentId: id,
            hiddenAt: hidden ? new Date() : null,
          })
          .onConflictDoUpdate({
            target: [agentPreferences.userId, agentPreferences.agentId],
            set: { hiddenAt: hidden ? new Date() : null },
          });
      });
    },

    softDelete(actor, id) {
      return database.transaction(
        async (transaction) => {
          await lockProfileMutationRows(transaction, id);
          const profile = await findAccessibleProfile(transaction, actor, id);
          if (!profile) throw new AgentNotFoundError(id);
          requireManageable(actor, profile);

          const deletedAt = new Date();
          await transaction
            .update(agentProfiles)
            .set({ deletedAt, updatedAt: deletedAt })
            .where(eq(agentProfiles.agentId, id));
        },
        { isolationLevel: "read committed" },
      );
    },

    issueCallbackToken(actor, id) {
      return database.transaction(
        async (transaction) => {
          await lockProfileMutationRows(transaction, id);
          const profile = await findAccessibleProfile(transaction, actor, id);
          if (!profile) throw new AgentNotFoundError(id);
          /*
           * Whoever may change the agent may credential it.
           *
           * The same gate as renaming it or repointing its endpoint, and repointing the endpoint is
           * the more dangerous of the two: it decides which process the token is for.
           */
          requireManageable(actor, profile);

          const token = mintCallbackToken();
          const issuedAt = new Date();
          await transaction
            .update(agentProfiles)
            .set({
              callbackTokenHash: hashCallbackToken(token),
              callbackTokenIssuedAt: issuedAt,
              updatedAt: issuedAt,
            })
            .where(eq(agentProfiles.agentId, id));

          // The only time it is readable. Nothing here writes it to a log.
          return token;
        },
        { isolationLevel: "read committed" },
      );
    },

    revokeCallbackToken(actor, id) {
      return database.transaction(
        async (transaction) => {
          await lockProfileMutationRows(transaction, id);
          const profile = await findAccessibleProfile(transaction, actor, id);
          if (!profile) throw new AgentNotFoundError(id);
          requireManageable(actor, profile);

          const now = new Date();
          await transaction
            .update(agentProfiles)
            .set({
              callbackTokenHash: null,
              callbackTokenIssuedAt: null,
              updatedAt: now,
            })
            .where(eq(agentProfiles.agentId, id));
        },
        { isolationLevel: "read committed" },
      );
    },

    agentForCallbackToken(hash) {
      return findByTokenHash(database, hash);
    },
  };
}
