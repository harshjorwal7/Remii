import { describe, expect, test } from "bun:test";
import {
  defaultAgentId,
  defaultAgentProfile,
  PICKED_HARNESS_AGENT_ID,
} from "@/lib/agents/default-agent";
import type { AgentProfile } from "@/lib/agents/queries";
import { REMII_AGENT_ID } from "@/lib/agents/default-agent";

function agent(id: string, name = id): AgentProfile {
  return {
    avatarSeed: id,
    mascot: null,
    canManage: true,
    hidden: false,
    id,
    mine: true,
    name,
    roleDescription: "Role",
    systemOwned: false,
    title: name,
    visibility: "private",
  };
}

describe("default agent selection", () => {
  test("prefers the picked harness over the first visible agent", () => {
    const chosen = defaultAgentProfile([
      agent(REMII_AGENT_ID, "General Assistant"),
      agent(PICKED_HARNESS_AGENT_ID, "LangGraph"),
    ]);

    expect(chosen?.id).toBe(PICKED_HARNESS_AGENT_ID);
    expect(
      defaultAgentId([agent(REMII_AGENT_ID), agent(PICKED_HARNESS_AGENT_ID)]),
    ).toBe(PICKED_HARNESS_AGENT_ID);
  });

  test("keeps the route-specific fallback when neither picked harness nor Remii is around", () => {
    const first = agent("researcher", "Researcher");
    const shared = agent("shared-agent", "Shared Agent");

    expect(defaultAgentProfile([first, shared], shared)?.id).toBe(
      "shared-agent",
    );
  });

  test("prefers Remii over the route-specific fallback", () => {
    const general = agent(REMII_AGENT_ID, "General Assistant");
    const shared = agent("shared-agent", "Shared Agent");

    expect(defaultAgentProfile([general, shared], shared)?.id).toBe(
      REMII_AGENT_ID,
    );
  });

  test("falls back to the first agent when no picked harness or route fallback exists", () => {
    expect(defaultAgentId([agent(REMII_AGENT_ID), agent("researcher")])).toBe(
      REMII_AGENT_ID,
    );
  });

  test("returns undefined when the roster is still absent", () => {
    expect(defaultAgentId(undefined)).toBeUndefined();
  });
});
