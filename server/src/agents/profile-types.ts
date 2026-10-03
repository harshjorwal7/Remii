import type { MascotChoice } from "../../../shared/mascot-ids";

// Strict per-user SaaS sandbox: public sharing is removed. The column stays
// in the database for compatibility, but every row is private.
export type AgentVisibility = "private";

/**
 * Individual-user SaaS has one role: every person is a user, sovereign over
 * their own coworkers, computers and connections. No administrator exists, so
 * no check may override ownership.
 */
export type AgentActor = {
  id: string;
  role: "user";
};

export type AgentProfile = {
  id: string;
  name: string;
  title: string;
  roleDescription: string;
  avatarSeed: string;
  /**
   * The mascot a coworker wears. Every field is nullable and null means "not chosen", never "empty" —
   * the client fills a null axis from `avatarSeed`, which is what lets an existing roster gain a
   * varied mascot without a backfill migration rewriting a single row.
   *
   * The ids come from `shared/mascot-ids.ts` and are the ones this codebase spells in English. The
   * renderer translates them into the engine's own French, in `app/src/mascot/ids.ts`, so a rename in
   * the engine cannot break a stored row.
   *
   * Partial rather than a whole `MascotChoice`, because that is genuinely what a row can hold: a
   * coworker whose owner has only ever picked a colour should still differ from its siblings in shape.
   * Null means no axis is set at all, which is every row written before this feature existed.
   */
  mascot: Partial<MascotChoice> | null;
  visibility: AgentVisibility;
  ownerUserId: string | null;
  isSystemTemplate?: boolean;
  /**
   * Whether this Bot is a supervisor rather than a worker.
   *
   * True means it holds no specialist capability of its own: no granted app
   * tools, no web research, no mail, no browser. It is left with the tools that
   * only a supervisor needs — delegating to a coworker, asking a question,
   * reading the roster, and administering the workspace — so that organising
   * other Bots is not merely what it is told to prefer but the only way it can
   * get the work done.
   *
   * Read from `agents.override`, the column a deployment already had, so
   * marking a Bot as a supervisor is a row and not a migration. Absent is
   * false: every Bot is a worker until a deployment says otherwise.
   */
  delegationOnly?: boolean;
  systemOwned: boolean;
  hidden: boolean;
  deletedAt: Date | null;
  /**
   * Where this coworker runs, as an AG-UI endpoint.
   *
   * Set only by the deployment, never by the person making the coworker: a create with no endpoint
   * stores the deployment's own Bot address, which is what "runs here" means. Internal Bots the
   * deployment ships (`agent-bot`, the harness picked at setup) carry their own.
   */
  endpoint: string | null;
};

export type CreateAgentInput = Pick<
  AgentProfile,
  "name" | "title" | "roleDescription" | "visibility" | "delegationOnly"
> & {
  /**
   * The mascot this coworker wears, or null to leave every axis to the seed.
   *
   * Partial on purpose, and the semantics are worth stating because the alternative is worse: a
   * supplied axis is kept and an omitted one is filled from `avatarSeed`. So a person who has only
   * ever picked a colour ends up with coworkers that differ in shape and expression, rather than
   * with eight identical circles. Absent and null both mean "leave it alone", which is what lets the
   * same field be used by the create form and by an edit that only wants to change the name.
   */
  mascot?: Partial<MascotChoice> | null;
};
