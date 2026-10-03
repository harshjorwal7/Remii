import type { ComputerConfig } from "../config";
/*
 * No SDK import here, and that is the point.
 *
 * The per-Bot sandbox providers are gone. A sandbox is now a PERSON's desktop
 * (user-computers.ts, provisioner.ts), and this file builds the providers that sit behind the
 * legacy per-Bot computer interface. Two providers that can each create a billed machine is how an
 * orphan sandbox with no database row claiming it happens, so the choice is made once, in index.ts,
 * and the branch that could reach a second one is not here to be taken.
 */
import type { ComputerStatus } from "./schema";

/** The address and lifecycle details for one Bot's computer. */
export type ComputerLocation = {
  botId: string;
  status: "running" | "stopped";
  url?: string;
  startedAt?: string;
  egress?: string | null;
};

/** A description of how a provider separates one Bot's computer from another. */
export type IsolationDescription = {
  isolation:
    | "off"
    | "one computer per Bot"
    | "one computer per user"
    | "one shared computer";
  note: string;
  warning?: string;
};

/** An error from a computer provider. */
export class ProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderError";
  }
}

/**
 * The per-user computer key for one (owner, Bot) pair — the Remii sandbox rule.
 *
 * Strict per-user SaaS sandbox: each user instance lives inside its own
 * sandbox, so user A never sees user B's browser, files, shell or logins.
 * The unit of isolation is the (user, Bot) pair, not the Bot: two users of
 * the same deployment template get two different computers, two different
 * disks, two different browser profiles.
 *
 * The key is derived deterministically (no database read on the hot path)
 * from the effective owner — the Bot's owner, or the acting user for
 * ownerless deployment templates — and the Bot id. It is REVERSIBLE by
 * {@link parseScopedComputerKey}: the owner slug travels in the key so a
 * provider can mount exactly `users/<ownerSlug>` — the same subpath the
 * sandbox providers have always used — with no lookup, on any replica:
 *
 *   `u_<ownerSlug>__b_<botSlug>__<pairHash>`
 *
 * - `u_<ownerSlug>` keeps pairs of different users apart even for the same
 *   Bot, and names the disk scope. The slugger never emits `_`, so the
 *   double-underscore separators are unambiguous.
 * - `b_<botSlug>` keeps pairs of different Bots apart for the same user.
 * - `pairHash` keeps two pairs that slug alike (differing only in
 *   punctuation, case, or past the slice length) on two different computers.
 *
 * Constraints the shape obeys: the Docker supervisor only accepts
 * `^[A-Za-z0-9][A-Za-z0-9_-]*$` (see supervisor/src/names.ts for the raised
 * limit), Kubernetes names and E2B names accept this shape too, and every
 * provider already slugs and hashes any string it is given — so the key
 * starts with a letter and carries only lowercase alphanumerics, hyphens
 * and underscores. Providers treat the key opaquely: it is the computer's
 * name to them, and only the gateway knows it names a (user, Bot) pair.
 */
export function scopeComputerKey(ownerId: string, botId: string): string {
  const slugOf = (value: string, length: number): string =>
    value
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, length) || "unnamed";
  const hashOf = (value: string): string => {
    let hash = 5381;
    for (let index = 0; index < value.length; index += 1) {
      hash = ((hash << 5) + hash + value.charCodeAt(index)) >>> 0;
    }
    return hash.toString(36);
  };
  // Full owner slug (a uuid survives whole), so the volume name derived
  // from the key is byte for byte the directory the user's disk already
  // lives in. Truncating it here would strand every existing disk.
  const ownerSlug = slugOf(ownerId, 40);
  const botSlug = slugOf(botId, 28);
  const pairHash = hashOf(`${ownerId}\0${botId}`);
  return `u_${ownerSlug}__b_${botSlug}__${pairHash}`;
}

/** Whether a computer key was produced by {@link scopeComputerKey}. */
export function isScopedComputerKey(key: string): boolean {
  return /^u_[a-z0-9-]*__b_[a-z0-9-]*__[0-9a-z]+$/.test(key);
}

/**
 * The (owner slug, Bot slug) a scoped key carries, or null for legacy keys.
 *
 * The Bot slug is truncated and the pair hash is one-way, so this recovers
 * the disk scope (the owner slug, which is what `users/<slug>` needs) but
 * never the full Bot id. Computer listings use it to report whose computer a
 * row is; addressing always goes through {@link scopeComputerKey}.
 */
export function parseScopedComputerKey(key: string): {
  ownerSlug: string;
  botSlug: string;
} | null {
  const match = /^u_([a-z0-9-]*)__b_([a-z0-9-]*)__[0-9a-z]+$/.exec(key);
  if (!match) return null;
  return { ownerSlug: match[1] ?? "", botSlug: match[2] ?? "" };
}

/** Describe the isolation that this provider (or lack of provider) gives to Bots. */
export function describeComputerIsolation(
  provider?: ComputerProvider,
): IsolationDescription {
  if (!provider) {
    return {
      isolation: "off",
      note: "The computer feature is off. No computer provider is configured.",
    };
  }
  if (provider.isolation === "per-user") {
    /*
     * One computer per PERSON, which is a different boundary from one per Bot, and
     * saying so plainly matters: two Bots of the same owner share a machine, a disk
     * and a memory ceiling, while two people never meet at all.
     */
    return {
      isolation: "one computer per user",
      note: "Each person gets their own computer, on their own disk, that no other person can reach. Within one person's computer, each Bot keeps its own browser profile, its own /workspace and its own verified Bot id, so one of their Bots cannot read another's files or logins.",
    };
  }

  if (provider.isolation === "per-bot") {
    return {
      isolation: "one computer per Bot",
      note: "Each Bot gets its own isolated computer with its own /workspace and browser profile.",
    };
  }

  /*
   * WHAT IS ACTUALLY SHARED, said precisely.
   *
   * This said "Sessions, files and logins are shared between them", which was true when the
   * computer had one `/workspace` and one profile directory for everything. Neither is true now: the
   * computer keeps a profile and a workspace per Bot, and verifies the Bot id rather than taking it
   * off a header. What IS shared is the machine — one container, one disk, one process, and so one
   * memory ceiling and one set of logins at the OS level.
   *
   * Overstating the sharing would have people read a warning that has been answered, and
   * understating it would hide the thing that is still true.
   */
  return {
    isolation: "one shared computer",
    note: "Every Bot shares one computer. Each keeps its own browser profile, its own /workspace and its own verified Bot id, so a Bot cannot read another's files or logins. The machine, the disk and the memory ceiling are shared.",
    warning:
      "One computer for every Bot. Bots are kept apart by directory and a signed id; if this deployment ever serves a second person, move to COMPUTER_SUPERVISOR_URL, which isolates people rather than Bots.",
  };
}

/**
 * What the hosted desktop isolates, which is NOT what this file's providers do.
 *
 * A hosted desktop is not a `ComputerProvider` and never goes through this seam, which left the boot
 * report calling it something it is not. `describeComputerIsolation(undefined)` answers `isolation:
 * "off"` with the sentence "The computer feature is off. No computer provider is configured." — and
 * that is exactly what a deployment with a working, billing, fully provisioned desktop used to record
 * in its audit trail and print on every boot. A reader of that audit would conclude the opposite of
 * the truth, from a deployment that had it configured correctly.
 *
 * The scope is passed in rather than read from a global, because the two models are genuinely
 * different products and only the deployment knows which one it is running. Said precisely either way:
 * one desktop per Bot is several machines and several bills for one person, and one desktop per
 * person is one machine that their Bots take turns on.
 */
export function describeHostedIsolation(
  scope: "per-bot" | "per-person",
): IsolationDescription {
  if (scope === "per-bot") {
    return {
      isolation: "one computer per Bot",
      note: "Each Bot gets its own desktop, with its own screen, its own mouse and keyboard, and its own desktop applications. Bots of the same person mount one shared disk, so they can hand each other a file, and the account sandbox quota is what limits how many run at once.",
    };
  }
  return {
    isolation: "one computer per user",
    note: "Each person gets their own desktop, on their own E2B volume, that no other person can reach. Every Bot of that person drives the same screen, so a person watching one Bot's work is watching the machine all of their Bots act on.",
  };
}

/**
 * A backend that gives Bots access to a computer.
 *
 * Implementations can use a computer for each Bot or one computer for all Bots.
 * Callers use this interface and do not need to know which backend is active.
 */
export interface ComputerProvider {
  /** The provider name for logs and status output. */
  readonly name: string;
  /** How the provider separates computers between Bots. */
  readonly isolation: "per-bot" | "per-user" | "shared";
  /**
   * Whether each computer answers to its OWN token, derived from the
   * deployment's for that (user, Bot) key, rather than to the deployment's
   * one shared value.
   *
   * Strict per-user sandboxing: with one token for the deployment, a computer
   * holding it could present it to every other computer on the host and drive
   * another user's browser, read their files and read their logins — the one
   * secret it was already given, and nothing left to tell the two apart. True
   * where the provider starts the computer and can therefore hand it only its
   * own derived token.
   */
  readonly instanceScopedTokens?: boolean;
  /** Return the base address of the computer for this Bot. */
  locate(botId: string): Promise<string>;
  /** Return the lifecycle state of the computer for this Bot. */
  status(botId: string): Promise<ComputerStatus>;
  /** Stop the computer for this Bot if it exists. */
  stop(botId: string): Promise<{ wasRunning: boolean }>;
  /** Remove the computer state for this Bot if it exists. */
  reset(botId: string): Promise<{ cleared: boolean }>;
  /** List the computers that this provider owns. */
  list(): Promise<ComputerLocation[]>;
  /** Prepare provider resources before the first computer request. */
  warm?(): Promise<void>;
  /**
   * Which run of this Bot's computer is current, if the provider can tell.
   *
   * A snapshot's generation only orders snapshots within one run: a replaced container counts from
   * one again, so a ref from the run before it matches a row nothing has overwritten. This is what
   * tells the two apart. Optional because a deployment with one shared computer has no supervisor to
   * ask, and there the comparison is skipped and behaviour is unchanged.
   */
  sessionOf?(botId: string): Promise<string | undefined>;
}

/**
 * Give every Bot the same computer.
 *
 * This adapter keeps shared deployments behind the same provider seam as the
 * Docker supervisor, and is the seam a remote backend plugs into.
/**
 * REMOVED: the shared-computer fallback.
 *
 * Strict per-user SaaS sandbox: a fallback that serves a Bot from one shared
 * local browser the moment its own sandbox fails is user A seeing user B's
 * computer by design — same /workspace, same browser process, same logins
 * surface. It reported `isolation: "per-bot"` while serving shared state,
 * which is the worst combination: mixed data behind a label that says
 * isolated.
 *
 * There is deliberately no fallback now. A sandbox that cannot serve fails
 * the turn with an error naming the sandbox, rather than silently succeeding
 * on somebody else's computer. Deployments that set a fallback address are
 * refused at startup (see createComputerProvider below) instead of running
 * mixed.
 */
/** Build the one computer provider selected by deployment configuration. */
/**
 * There is no per-Bot computer provider any more, and this throws rather than returning one.
 *
 * The computer is an E2B desktop: one per PERSON, persistent, provisioned on demand
 * (provisioner.ts), watched and driven through the desktop stream (desktop-stream.ts), and used by
 * the agent through the desktop tools (desktop-tools.ts). Every provider that used to be reachable
 * from here existed to run a Chromium in a container — a shared local one, a per-Bot one behind the
 * Docker supervisor, a Kubernetes sandbox, or a per-Bot sandbox — and all of those are gone.
 *
 * Kept as a function rather than deleted because the types it returns are still what the routes and
 * the schema describe, and deleting the signature before the surface it describes is the kind of
 * change that leaves a repository in a state nobody can build. It fails loudly, so nobody believes
 * they have a computer that does not exist.
 */
export function createComputerProvider(
  _config: ComputerConfig,
  _deps?: { ownerOf?: (botId: string) => Promise<string | null> },
): ComputerProvider {
  throw new Error(
    "This deployment has no per-Bot computer. The computer is a hosted desktop, one per person, and it is reached through the computer provisioner rather than this interface.",
  );
}
