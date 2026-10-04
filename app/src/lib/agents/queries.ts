import { queryOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";
import type { MascotChoice } from "../../../../shared/mascot-ids";

export type AgentVisibility = "private";

/**
 * A coworker as the browser sees it.
 *
 * `canManage` and `systemOwned` are server-decided authorization facts; components render from the
 * returned flags rather than recomputing ownership rules.
 */
export type AgentProfile = {
  id: string;
  name: string;
  title: string;
  roleDescription: string;
  avatarSeed: string;
  /**
   * The mascot this coworker wears, or null when nobody has chosen one.
   *
   * Null and not a defaulted value: the client resolves it from `avatarSeed`, which is what gives
   * every existing coworker a distinct mascot without a migration rewriting a row. Partial rather than
   * whole, because a person who has only picked a colour should still see their coworkers differ in
   * shape — see `mergeMascotChoice`.
   */
  mascot: Partial<MascotChoice> | null;
  /** When this coworker was paused, or null when it is running. */
  pausedAt?: string | null;
  pausedReason?: string | null;
  visibility: AgentVisibility;
  hidden: boolean;
  systemOwned: boolean;
  canManage: boolean;
  /**
   * Whether the signed-in person created this coworker.
   *
   * Separate from `canManage`, which is also true for administrators on everybody's coworkers. Split
   * a roster on `canManage` and an administrator's "mine" fills up with other people's work.
   */
  mine: boolean;
  isSystemTemplate?: boolean;
};

export const agentKeys = {
  all: ["agents"] as const,
  list: (hidden = false) => ["agents", "list", { hidden }] as const,
  detail: (agentId: string) => ["agents", "detail", agentId] as const,
  botRouteDetail: (agentId: string) =>
    ["agents", "bot-route-detail", agentId] as const,
  handoff: (agentId: string) => ["agents", "handoff", agentId] as const,
};

/** Which Bots one Bot may hand work to, and whether this deployment lets it. */
export type HandoffGrants = {
  /**
   * Whether the capability is switched on at all.
   *
   * Separate from the grants because the two fail differently: with this false, a grant is a row
   * nothing will ever read, so the screen says so rather than offering a switch wired to nothing.
   */
  enabled: boolean;
  /** Whether the signed-in person may change any of it. Granting is an administrator's. */
  canGrant: boolean;
  /** Bot ids this Bot may address today. */
  reachable: string[];
  /**
   * Whether this Bot can hold such a grant at all.
   *
   * The handing-on tool executes inside this deployment's own run loop, so only a Bot that runs in
   * it can be offered one. False means every grant would be refused, and the screen should say that
   * once instead of letting each switch bounce with the same message.
   */
  grantable: boolean;
};

export function agentListQueryOptions(hidden = false) {
  return queryOptions({
    queryKey: agentKeys.list(hidden),
    queryFn: (): Promise<AgentProfile[]> =>
      client(`/api/agents${hidden ? "?hidden=true" : ""}`, "agents", {
        fallback: "Could not load coworkers",
      }),
  });
}

/** Package-defined IDs remain one path segment without changing their stored or cache identity. */
export function agentApiPath(agentId: string): string {
  return `/api/agents/${encodeURIComponent(agentId)}`;
}

export function agentQueryOptions(agentId: string) {
  return queryOptions({
    queryKey: agentKeys.detail(agentId),
    queryFn: (): Promise<AgentProfile> =>
      client(agentApiPath(agentId), "agent", {
        fallback: "Could not load this coworker",
      }),
  });
}

export function agentHandoffQueryOptions(agentId: string) {
  return queryOptions({
    queryKey: agentKeys.handoff(agentId),
    queryFn: (): Promise<HandoffGrants> =>
      client(`${agentApiPath(agentId)}/handoff`, "handoff", {
        fallback: "Could not load which Bots this one may ask",
      }),
  });
}
