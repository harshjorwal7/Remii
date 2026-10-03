import { describe, expect, test } from "bun:test";
import {
  canAccessAgent,
  canManageAgent,
  canRunAgent,
} from "../src/agents/profile-policy";
import type { AgentActor, AgentProfile } from "../src/agents/profile-types";

const creator: AgentActor = { id: "user-1", role: "user" };
const otherUser: AgentActor = { id: "user-2", role: "user" };
const admin: AgentActor = { id: "admin-1", role: "admin" };

function profile(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    id: "agent-1",
    name: "Researcher",
    title: "Research Assistant",
    roleDescription: "Finds and summarizes information.",
    avatarSeed: "researcher",
    visibility: "private",
    ownerUserId: creator.id,
    systemOwned: false,
    hidden: false,
    deletedAt: null,
    ...overrides,
  };
}

describe("agent profile permissions", () => {
  /*
   * WAS "allows every actor to access and run an active public profile", expecting three actors to
   * reach a row marked `visibility: "public"`.
   *
   * Public sharing was removed: `canAccessAgent` decides on `systemOwned` or `ownerUserId === actor.id`
   * and never reads `visibility`, so a public row is nobody else's business. The visibility value is
   * kept in the fixture deliberately — the column may still hold `public` on old rows — and the point
   * is that carrying it grants nothing.
   */
  test("grants nothing to a non-owner on the strength of a public row", () => {
    const agent = profile({ visibility: "public", hidden: true });

    expect(canAccessAgent(creator, agent)).toBe(true);
    expect(canRunAgent(creator, agent)).toBe(true);
    for (const actor of [otherUser, admin]) {
      expect(canAccessAgent(actor, agent)).toBe(false);
      expect(canRunAgent(actor, agent)).toBe(false);
    }
  });

  /*
   * WAS "...to its creator and admins". There is no administrator override left to grant: an actor
   * carrying `role: "admin"` is refused exactly as any other non-owner is, which is the property that
   * replaced the override. The admin is kept in the fixture so a future `role === "admin"` branch
   * shows up here as a disagreement rather than as an absence.
   */
  test("limits active private profile access and runs to its creator alone", () => {
    const agent = profile({ visibility: "private" });

    expect(canAccessAgent(creator, agent)).toBe(true);
    expect(canRunAgent(creator, agent)).toBe(true);
    for (const actor of [otherUser, admin]) {
      expect(canAccessAgent(actor, agent)).toBe(false);
      expect(canRunAgent(actor, agent)).toBe(false);
    }
  });

  /*
   * WAS "...and admins". Management is the caller's own Bot and nothing else, whatever visibility the
   * row carries — which is why both values are in the loop and neither changes the answer.
   */
  test("allows only the creator to manage an active user profile", () => {
    for (const visibility of ["public", "private"] as const) {
      const agent = profile({ visibility });

      expect(canManageAgent(creator, agent)).toBe(true);
      for (const actor of [otherUser, admin]) {
        expect(canManageAgent(actor, agent)).toBe(false);
      }
    }
  });

  test("allows all actors to access and run a system public profile but nobody to manage it", () => {
    const agent = profile({
      visibility: "public",
      ownerUserId: null,
      systemOwned: true,
    });

    for (const actor of [creator, otherUser, admin]) {
      expect(canAccessAgent(actor, agent)).toBe(true);
      expect(canRunAgent(actor, agent)).toBe(true);
      expect(canManageAgent(actor, agent)).toBe(false);
    }
  });

  test("denies every permission for deleted profiles", () => {
    const agent = profile({
      visibility: "public",
      deletedAt: new Date("2026-08-14T00:00:00.000Z"),
    });

    for (const actor of [creator, otherUser, admin]) {
      expect(canAccessAgent(actor, agent)).toBe(false);
      expect(canManageAgent(actor, agent)).toBe(false);
      expect(canRunAgent(actor, agent)).toBe(false);
    }
  });

  test("exports canRunAgent as the canAccessAgent alias", () => {
    expect(canRunAgent).toBe(canAccessAgent);
  });
});
