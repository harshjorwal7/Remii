/**
 * Computer tables: agent computers, sessions, computer-use audit.
 *
 * Split by owner so two people can add tables all day without touching the same lines. Add tables
 * here; never edit core.ts or coworker.ts to do it.
 */
import {
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { users } from "./core";
import { agentProfiles } from "./coworker";
import { jsonb } from "./json";

/**
 * The boundary this deployment is enforcing, kept where a restart cannot lose it.
 *
 * This table keeps policy across restarts. The policy can be changed while running, and a restart
 * must not silently return to the default.
 *
 * Scoped by user. Free and starter users follow the platform default, while Pro and Power users
 * can define custom deny/allow action rules.
 *
 * Memory is still the cache. The gateway asks for the policy on every action, so it reads from
 * memory; this is the record that survives a restart, not something on the path of a click.
 */
export const actionPolicy = pgTable("action_policy", {
  /*
   * Whose boundary this row is — a user id, or the platform default.
   *
   * Deliberately NOT a foreign key to users, following the audit trail's own
   * rule (see actorUserId in core.ts): a boundary must survive the person who
   * wrote it being removed, and a removal must never cascade into wiping
   * what is enforced. The store writes actor ids for custom rows; reads fall
   * back to the platform row when a person holds none.
   */
  userId: text("user_id").primaryKey(),
  /** `enforce` or `dry-run`. Not an enum: the policy module owns that vocabulary. */
  mode: text("mode").notNull(),
  deny: text("deny").array().notNull(),
  allow: text("allow").array().notNull(),
  /** Who last changed it, for the Admin page and the trail. */
  updatedBy: text("updated_by"),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * Which (user, Bot) pair a scoped computer key names, kept where every
 * replica can read it.
 *
 * The gateway addresses computers by scope key (`u_<owner>__b_<bot>__<hash>`),
 * which is one-way in its Bot half: a replica that only lists the fleet
 * cannot recover the Bot id or the owner from the key alone. The in-memory
 * map covers the replica that located the computer; this table covers every
 * other one, so the fleet answers "whose computer is this" instead of an
 * opaque internal name. One row per key, upserted on locate; owner ids are
 * plain text with no foreign key, so removing a person never cascades into
 * wiping the fleet record.
 */
export const computerScopes = pgTable(
  "computer_scopes",
  {
    key: text("key").primaryKey(),
    botId: text("bot_id").notNull(),
    owner: text("owner").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("computer_scopes_owner_idx").on(table.owner)],
);

/**
 * The last snapshot a computer produced, kept where every replica can read it.
 *
 * The gateway resolves the opaque ref in an acting call into the element it points at, and it must
 * resolve it against the snapshot the ref came from, never against a label the caller supplied. That
 * mapping used to live in a `Map` inside one process. Remii runs several processes behind a load
 * balancer, and the process that took the snapshot is rarely the one that handles the click that
 * follows it, so the mapping was absent exactly when a click arrived on another replica: the policy
 * then decided with no element in front of it and the audit row could not name what was touched. The
 * boundary the whole gateway exists for stopped applying, and nothing said so.
 *
 * One row per computer, upserted on every snapshot: the newest one wins, because a ref is only ever
 * resolved against the snapshot that is current. `snapshot_id` is the generation the far-side
 * computer stamped on it, so a ref carrying an older generation does not resolve to whatever now
 * holds that ref — the staleness a persisted cache is rightly warned about is answered by matching
 * the generation, not by keeping the cache in memory.
 *
 * Kept small on purpose: only the interactive elements a policy can match on, keyed by ref. It is a
 * resolution table for the boundary, not a history of pages, and the next snapshot replaces it.
 */
export const computerSnapshot = pgTable("computer_snapshot", {
  /** The computer these refs belong to. One live snapshot each, so it is the key. */
  computerId: text("computer_id").primaryKey(),
  /** The generation the computer stamped on this snapshot. A ref names the one it came from. */
  snapshotId: integer("snapshot_id").notNull(),
  /** The page it was taken on, so a rule about the host still has a page to match after a handover. */
  url: text("url").notNull(),
  /** The interactive elements, keyed by ref. The one thing resolve looks a ref up in. */
  elements: jsonb("elements").notNull(),
  takenAt: timestamp("taken_at", { withTimezone: true }).notNull().defaultNow(),
  /**
   * Which run of the computer took it.
   *
   * The generation only tells snapshots apart within one session: a replaced container counts from
   * one again, so a ref from a dead session matches a row the new one has not overwritten yet, and
   * the policy decides against an element from a page that no longer exists. Reset clears the row
   * for exactly that reason, but reset is not the only way a computer is replaced — an image change
   * does it too, and the server is never told. This is the session, so a stale row is recognisable
   * without anybody having to remember to delete it.
   *
   * Null where the provider cannot say, which is a deployment with one shared computer and no
   * supervisor. There the behaviour is what it was before this column existed.
   */
  session: text("session"),
});

/**
 * What a Bot's screen looked like on the turn that opened it.
 *
 * A conversation is a record, and a record must not change its mind. The transcript used to fetch
 * the live screen for every past turn, so an answer about one page sat under a picture of whichever
 * page the Bot had open by the time somebody read it back.
 *
 * KEYED ON THE TURN, which is the identity of the thing being remembered. Keying on the page instead
 * was a mistake with a plausible reason: two visits to one address collided, and letting the newer
 * win made a past turn's picture change under it, which is the exact mutability this table exists to
 * remove. A turn happens once and is then over for good, so the row is written once and never
 * updated.
 *
 * The computer is in the key as well as the turn, so a caller who may reach one Bot cannot read
 * another Bot's screen by naming a tool call.
 */
export const computerPageFrame = pgTable(
  "computer_page_frame",
  {
    /** Whose computer it was. */
    computerId: text("computer_id").notNull(),
    /** The turn that opened it. */
    toolCallId: text("tool_call_id").notNull(),
    /** The page, as the browser reported it after the navigation settled. */
    url: text("url").notNull(),
    title: text("title"),
    /**
     * The frame itself, base64 PNG.
     *
     * Bounded by the code that writes it rather than by the column, because the useful limit is "a
     * screenshot" and the honest failure is a refusal at the boundary rather than a database error.
     */
    frame: text("frame").notNull(),
    capturedAt: timestamp("captured_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.computerId, table.toolCallId] }),
    // The reaper's query: everything older than the retention window, whoever it belongs to.
    index("computer_page_frame_captured_idx").on(table.capturedAt),
  ],
);

/**
 * Lifecycle of the ONE computer a person has.
 *
 * The `user_id` uniqueness is the whole design and everything else follows from it: a chat does not
 * own a computer, a thread does not own a computer, and neither can be given a second one. A user's
 * computer outlives every conversation, which is the only way "log in tomorrow and Chrome is still
 * signed in" can be true.
 *
 * `sandbox_id` is stored rather than derived, which is a correction. The name used to be computed
 * from the owner slug on every call, so nothing anywhere held the id: a renamed user silently
 * addressed a sandbox that no longer matched, and there was no way to ask the platform what this
 * database believed it owned. A row per user is what makes reconciliation possible at all.
 */
export const userComputers = pgTable(
  "user_computers",
  {
    id: text("id").primaryKey(),
    /**
     * One computer per person, enforced by the database rather than by a check in the handler.
     *
     * A handler-level check is a race: two requests for a user with no computer both read "none"
     * and both provision. The unique index means the second one fails to insert instead, and the
     * caller that lost the race reads the winner's row and uses their sandbox.
     */
    userId: text("user_id")
      .notNull()
      .unique()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Which infrastructure is behind this. `e2b` today; the old local computer was `agent-computer`. */
    provider: text("provider").notNull().default("e2b"),
    /** The provider's own id for the machine. Null while PROVISIONING and after a failed attempt. */
    sandboxId: text("sandbox_id"),
    status: text("status").notNull().default("NONE"),
    /**
     * What the person last asked for, as distinct from where the machine actually is.
     *
     * Separated because a stop and a start are not instantaneous: the pair is what lets a request
     * that arrives mid-transition be answered with the right answer ("stopping") rather than by
     * fighting the transition or reporting the wrong one. Collapsing them into one column is how a
     * deployment ends up unable to say whether a machine it is billing for is wanted.
     */
    desiredStatus: text("desired_status").notNull().default("RUNNING"),
    /** Real geometry, read back from the running desktop. Never assumed and never hard-coded. */
    displayWidth: integer("display_width"),
    displayHeight: integer("display_height"),
    /**
     * The image this computer was built from, so a fleet can be told which machines predate a
     * desktop change instead of every one of them being an unknown.
     */
    imageVersion: text("image_version"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastStartedAt: timestamp("last_started_at", { withTimezone: true }),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    /**
     * Who has the wheel on this computer: the Bot, or a person.
     *
     * It exists because a desktop is ONE machine with ONE mouse and ONE keyboard, and the old
     * model did not have this problem — a Bot's browser was its own, and a person "taking over" was
     * a control flag in a per-Bot HTTP service. Here the person and the Bot drive the same desktop,
     * so without this a click can land in the middle of a keystroke and neither side can tell.
     *
     * The other half is that refusing the Bot is only useful if the Bot is TOLD. Every action while
     * a person holds it answers with a sentence saying a person has control, which is what the run
     * can surface rather than a mysterious silence.
     */
    controlHolder: text("control_holder").notNull().default("bot"),
    /** When the wheel last changed hands, so a stuck holder can be reasoned about. */
    controlSince: timestamp("control_since", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("user_computers_sandbox_idx").on(table.sandboxId)],
);

/**
 * One desktop per Bot, on the person's shared disk.
 *
 * The disk is shared and the screen is not. That combination is the whole point: a Bot that shares
 * files with its siblings but has its own display, its own mouse and its own keyboard can hand work
 * to another Bot without the two fighting over one pointer, which is exactly the collision that made
 * a person and a Bot on one desktop unsafe.
 *
 * `userId` is carried rather than joined, because two different questions are asked of this row and
 * they are not the same question. "Whose disk does this Bot share" is `userId`, and it is what
 * picks the volume subpath. "Whose machine is this" is `botId`, and it is what makes the desktop
 * separate. Reading one from the other is how a Bot ends up on a stranger's disk.
 *
 * The shared subpath is a real hazard and is not hidden here. Daytona volumes are FUSE-backed and
 * explicitly NOT transactional: two Bots writing the same path at once is silent last-write-wins.
 * `scratchSubpath` exists so each Bot has somewhere of its own to work without racing a sibling,
 * and the shared tree is for deliberate handoff.
 */
export const botComputers = pgTable(
  "bot_computers",
  {
    id: text("id").primaryKey(),
    /**
     * One desktop per Bot, by unique index rather than by a check in the handler.
     *
     * The same race the person-level table has: two requests for a Bot with no desktop both read
     * "none" and both provision. The loser fails to insert and uses the winner's sandbox.
     */
    botId: text("bot_id")
      .notNull()
      .unique()
      .references(() => agentProfiles.agentId, { onDelete: "cascade" }),
    /** Whose disk this Bot shares. Also whose quota the sandbox is billed to. */
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: text("provider").notNull().default("e2b"),
    /** The provider's own id for the machine. Null while PROVISIONING and after a failed attempt. */
    sandboxId: text("sandbox_id"),
    status: text("status").notNull().default("NONE"),
    /** What the Bot last needed, as distinct from where its machine actually is. */
    desiredStatus: text("desired_status").notNull().default("RUNNING"),
    /** Real geometry, read back from the running desktop. Never assumed and never hard-coded. */
    displayWidth: integer("display_width"),
    displayHeight: integer("display_height"),
    imageVersion: text("image_version"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastStartedAt: timestamp("last_started_at", { withTimezone: true }),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    /**
     * Who drives THIS Bot's desktop.
     *
     * Per Bot, not per person, because there are now several independent machines. A person holding
     * Bot A's wheel stops Bot A and nothing else, which is the point of giving every Bot its own
     * screen; a single person-level flag would stop the lot and make the isolation pointless.
     */
    controlHolder: text("control_holder").notNull().default("bot"),
    controlSince: timestamp("control_since", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("bot_computers_sandbox_idx").on(table.sandboxId),
    index("bot_computers_user_idx").on(table.userId),
  ],
);
