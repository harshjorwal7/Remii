import { expect, test } from "bun:test";
import { createAgentRegistry } from "../src/agents/registry";

test("reports in-process and AG-UI-reached availability without secrets", () => {
  expect(
    createAgentRegistry(
      [
        {
          id: "knowledge",
          name: "Knowledge",
          type: "built_in",
          credentialRef: "openai",
        },
        {
          id: "risk",
          name: "Risk",
          type: "remote_ag_ui",
          endpoint: "https://risk.example/ag-ui",
        },
      ],
      new Set(["openai"]),
    ),
  ).toEqual([
    { id: "knowledge", name: "Knowledge", type: "built_in", available: true },
    { id: "risk", name: "Risk", type: "remote_ag_ui", available: true },
  ]);
});

test("marks an agent with no model credential unavailable and says why", () => {
  expect(
    createAgentRegistry(
      [
        {
          id: "knowledge",
          name: "Knowledge",
          type: "built_in",
          credentialRef: "openai",
        },
        {
          id: "risk",
          name: "Risk",
          type: "remote_ag_ui",
          endpoint: "ftp://risk.example",
        },
      ],
      new Set(),
    ),
  ).toEqual([
    {
      id: "knowledge",
      name: "Knowledge",
      type: "built_in",
      available: false,
      reason: "Model credential is not configured.",
    },
    {
      id: "risk",
      name: "Risk",
      type: "remote_ag_ui",
      available: false,
      reason: "AG-UI endpoint is invalid.",
    },
  ]);
});

test("an address this deployment configured is not screened again at read time", () => {
  /*
   * WAS covered by the same two cases as an invalid address, back when a person could type one in.
   * The check stayed, and it is worth saying why it is now only a sanity check: every address here
   * comes from this deployment's own configuration — the Bot it ships in the box, or the harness
   * chosen at setup — so nothing untrusted is left to screen, and a malformed one is a broken
   * deployment rather than an attempt.
   */
  expect(
    createAgentRegistry(
      [
        {
          id: "risk",
          name: "Risk",
          type: "remote_ag_ui",
          endpoint: "http://127.0.0.1:4200/ag-ui",
        },
      ],
      new Set(),
    ),
  ).toEqual([
    { id: "risk", name: "Risk", type: "remote_ag_ui", available: true },
  ]);
});
