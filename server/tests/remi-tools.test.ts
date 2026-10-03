import { describe, expect, test } from "bun:test";
import { createRemiStore } from "../src/remi/store";
import { REMI_TOOL_NAMES, remiToolsFor } from "../src/remi/tools";
import { REMII_AGENT_ID } from "../../shared/remii";

/**
 * The Remi mind tools a run is offered, minus the network and the database.
 *
 * The store is constructed but never called here: listing tool names touches neither. What
 * pins the contract is the gating — web search is offered if and only if the deployment
 * configured an endpoint — because a model offered a search it cannot run spends attention
 * on it and then apologises.
 */

function toolNames(
  endpoint: { webSearchApiKey?: string; webSearchBaseUrl?: string } = {},
): string[] {
  const store = createRemiStore({
    // Never called by this test: only the tool list is read.
    database: {} as never,
  });
  return remiToolsFor({
    store,
    botId: REMII_AGENT_ID,
    actorId: "user-1",
    tools: { database: {} as never, ...endpoint },
  }).map((tool) => tool.name);
}

describe("remi tool names", () => {
  test("the router knows every offered name", () => {
    for (const name of toolNames({ webSearchApiKey: "key" })) {
      expect(REMI_TOOL_NAMES as readonly string[]).toContain(name);
    }
  });

  test("web search is withheld without an endpoint", () => {
    const names = toolNames();
    expect(names).not.toContain("web_search");
    expect(names).not.toContain("web_open");
    expect(names).toContain("memory_search");
  });

  test("a key offers both web tools", () => {
    const names = toolNames({ webSearchApiKey: "key" });
    expect(names).toContain("web_search");
    expect(names).toContain("web_open");
  });

  test("a base URL alone offers both web tools", () => {
    const names = toolNames({ webSearchBaseUrl: "http://localhost:9999" });
    expect(names).toContain("web_search");
    expect(names).toContain("web_open");
  });
});
