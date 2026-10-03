import { queryOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";

/** One Bot's computer, as Admin sees it. */
export type ComputerProfile = {
  botId: string;
  running: boolean;
  startedAt: string | null;
  /** Absent when the provider does not report egress at all, which is not the same as none. */
  egress?: string | null;
};

/**
 * Whether each Bot has a browser profile of its own, or they share one.
 *
 * `per-user` is the newest and the one a hosted provider reports: one computer per PERSON, holding
 * every one of their Bots, each with its own screen. It is deliberately not folded into "shared" —
 * sharing within one person's computer is not sharing between people's, and a UI that called it
 * shared would warn about a risk that does not exist here.
 */
export type ComputerIsolation = "per-bot" | "per-user" | "shared";

/** What the list endpoint answers: the computers, and how they are separated. */
export type ComputerFleet = {
  computers: ComputerProfile[];
  isolation?: ComputerIsolation;
};

/**
 * Whether the boundary acts on its verdict.
 *
 * `dry-run` records what it would have refused without refusing it, which is how a policy is tried
 * out before it stops a Bot mid-task.
 */
export type PolicyMode = "dry-run" | "enforce";

/** The rules a Bot's actions are judged against. */
export type ActionPolicy = {
  mode: PolicyMode;
  deny: string[];
  allow: string[];
};

/**
 * The ONE computer this person has, and the hours behind it.
 *
 * Replaces the fleet read, which listed a computer per Bot. It answered from `bot_computers`, which
 * nothing has written since the per-Bot provisioner was removed, so every Bot came back `NONE` and the
 * Settings page drew a list of computers that did not exist — while the person's actual desktop, one
 * row away, was never shown at all.
 */
/**
 * What `/api/computers/desktop/state` answers.
 *
 * `computer` IS NULLABLE AND THAT IS THE COMMON CASE, so the type says so rather than the page
 * defending against it at runtime. A person who has never asked Remii for a screen has no row at all,
 * and the endpoint answers `{ computer: null, reason: "no-computer-yet" }` — which is not an error,
 * not a machine that is switched off, and not something to retry. It was declared non-nullable here
 * and the page reached for `?? null` to cover it, which is a type that documents the opposite of the
 * contract and a check that exists only because the type lied.
 *
 * The hours are absent alongside a null computer for the same reason: there is no session to have
 * spent any.
 */
export type DesktopState = {
  computer: {
    status: string;
    displayWidth: number | null;
    displayHeight: number | null;
    lastSeenAt: string | null;
  } | null;
  /** Named on the null case only, so a caller can say why rather than guess. */
  reason?: string;
  hoursUsed?: number;
  hoursIncluded?: number;
  isolation?: "per-person";
};

export const computerKeys = {
  all: ["computers"] as const,
  fleet: () => ["computers", "fleet"] as const,
  state: () => ["computers", "state"] as const,
  policy: () => ["computers", "policy"] as const,
};

/**
 * The signed-in person's own desktop, and how far along it is.
 *
 * `refetchInterval` is the caller's decision, not this module's, because it depends on the screen:
 * the settings page polls while a start is in flight (a cold boot is two minutes of nothing visible,
 * and a page frozen on a spinner reads as a hang), while a component that only needs the row on
 * mount does not poll at all.
 */
export function desktopStateQueryOptions(
  options: { refetchInterval?: number | false } = {},
) {
  return queryOptions({
    queryKey: computerKeys.state(),
    ...(options.refetchInterval === undefined
      ? {}
      : { refetchInterval: options.refetchInterval }),
    queryFn: async (): Promise<DesktopState | null> => {
      const response = await client("/api/computers/desktop/state", {
        fallback: "Your computer could not be read.",
      });
      // A body with no `computer` key is the honest answer for a person who has never had one: the
      // desktop is provisioned on the first turn that needs it, and refusing to start it by opening a
      // settings page is deliberate. That is not an error and must not render as one.
      return (await response.json()) as DesktopState | null;
    },
  });
}

/**
 * The deployment-wide fleet route.
 *
 * Not a Bot id in a member route, which is what this used to be. That placeholder stopped working
 * when the server began checking whether the caller may act as the Bot in the path: a placeholder
 * is not a Bot, so the list 404d and this screen showed nothing at all.
 */
/*
 * The desktop fleet.
 *
 * This used to be `/api/computers/fleet`, on the old per-Bot computer router. That whole router is
 * mounted only when a computer gateway exists, and there is no gateway behind the E2B desktop —
 * so the path answered 404, the Settings computer page rendered an empty list, and it had no way to
 * say why. The desktop router is mounted whenever there is a desktop to list, which is exactly when
 * this page has something to show.
 */
const FLEET_PATH = "/api/computers/desktop/fleet";

/** No envelope key: the body carries both the list and the isolation mode. */
export function computerFleetQueryOptions() {
  return queryOptions({
    queryKey: computerKeys.fleet(),
    queryFn: async (): Promise<ComputerFleet> => {
      const response = await client(FLEET_PATH, {
        fallback: "The computers could not be listed.",
      });
      return response.json();
    },
  });
}

export function actionPolicyQueryOptions() {
  return queryOptions({
    queryKey: computerKeys.policy(),
    queryFn: (): Promise<ActionPolicy> =>
      client("/api/computers/policy", "policy", {
        fallback: "The boundary could not be read.",
      }),
  });
}

/** One recorded action a candidate policy would decide differently than what happened. */
export type DryRunChange = {
  id: string;
  createdAt: string;
  action: string;
  bot: string;
  page: string;
  element: { role: string; name: string } | null;
  command: string | null;
  file: string | null;
  was: "allowed" | "refused";
  would: "allowed" | "refused";
  rule: string | null;
  reason: string;
};

export type DryRunReport = {
  scanned: number;
  wouldRefuse: number;
  wouldAllow: number;
  unchanged: number;
  /** Capped by the server; the counts cover everything scanned. */
  changes: DryRunChange[];
};

/**
 * What would this policy have decided, about recent recorded actions?
 *
 * A plain function rather than a query: the answer is about this candidate at this moment, nothing
 * caches it and nothing invalidates it. It writes nothing — not the policy, and no audit row.
 */
export async function dryRunActionPolicy(
  candidate: ActionPolicy,
): Promise<DryRunReport> {
  return client("/api/computers/policy-dry-run", "report", {
    method: "POST",
    body: { policy: candidate },
    fallback: "The rule could not be tested against history.",
  });
}
