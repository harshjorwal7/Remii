import { describe, expect, test } from "bun:test";
import { runForDuplicate } from "../src/agents/profile-store";

/**
 * What a duplicated coworker runs on.
 *
 * A pure decision, tested without a database, because the failure it exists to stop is silent: the
 * copy is created, appears on the roster, answers when asked, and is a different coworker from the
 * one that was copied.
 *
 * Two shapes reach here. A Bot in the box keeps its whole instruction in `configuration.systemPrompt`
 * and has no endpoint at all. A Bot reached over AG-UI keeps the address it is dialled at, which is
 * how this deployment's own Bot and a harness chosen at setup are both registered — by the tenant
 * package, from configuration, and not from anything a person supplies.
 */

const managed = { endpoint: "http://managed.invalid/ag-ui" };

describe("what a copy runs on", () => {
  /*
   * The bug. A Bot in the box keeps its whole instruction in `configuration.systemPrompt` and has no
   * endpoint at all, so an endpoint-only read came back empty, the copy fell through to the managed
   * Bot, and the prompt went nowhere. The default tenant package ships two of these.
   */
  test("keeps a Bot in the box's prompt, and stays a Bot in the box", () => {
    expect(
      runForDuplicate(
        {
          type: "built_in",
          configuration: { systemPrompt: "Never answer from memory." },
        },
        managed,
      ),
    ).toEqual({
      type: "built_in",
      configuration: { systemPrompt: "Never answer from memory." },
    });
  });

  test("needs no managed Bot to copy one that brought its own prompt", () => {
    // The mirror of the endpoint case: a source that carries what it runs on does not fall back.
    expect(
      runForDuplicate(
        { type: "built_in", configuration: { systemPrompt: "Be brief." } },
        undefined,
      ),
    ).toEqual({
      type: "built_in",
      configuration: { systemPrompt: "Be brief." },
    });
  });

  test("keeps the endpoint the source was copied from", () => {
    // The Bot this deployment ships in the box and a harness chosen at setup are both registered this
    // way, so this is the common case rather than an exception.
    expect(
      runForDuplicate(
        {
          type: "remote_ag_ui",
          configuration: { endpoint: "http://ours.invalid/ag-ui" },
        },
        managed,
      ),
    ).toEqual({
      type: "remote_ag_ui",
      configuration: { endpoint: "http://ours.invalid/ag-ui" },
    });
  });

  test("falls back to the managed Bot only when the source runs on nothing of its own", () => {
    expect(
      runForDuplicate({ type: "built_in", configuration: {} }, managed),
    ).toEqual({ type: "remote_ag_ui", configuration: managed });
  });

  test("has nowhere to put a copy of a coworker with nothing, and no managed Bot", () => {
    // Null is what the caller turns into a refusal. It must not be reachable for a source that had a
    // prompt, which is what the second case above pins.
    expect(
      runForDuplicate({ type: "remote_ag_ui", configuration: {} }, undefined),
    ).toBeNull();
  });

  test("treats a blank prompt as no prompt, the way the runtime does", () => {
    // `registeredAgentFromRow` refuses to build a Bot from a whitespace prompt, so copying one as
    // `built_in` would produce a coworker that cannot be built at all.
    expect(
      runForDuplicate(
        { type: "built_in", configuration: { systemPrompt: "   " } },
        managed,
      ),
    ).toEqual({ type: "remote_ag_ui", configuration: managed });
  });

  test("does not read a prompt off a coworker that runs somewhere else", () => {
    // The type decides, not the presence of a key. A remote row carrying a stray `systemPrompt` is
    // still a remote Bot, and copying it as built-in would move it into this process.
    expect(
      runForDuplicate(
        {
          type: "remote_ag_ui",
          configuration: {
            endpoint: "http://ours.invalid/ag-ui",
            systemPrompt: "ignored",
          },
        },
        managed,
      ),
    ).toEqual({
      type: "remote_ag_ui",
      configuration: { endpoint: "http://ours.invalid/ag-ui" },
    });
  });

  test("keeps a Mastra coworker on its own protocol and names its agent", () => {
    /*
     * A Mastra server speaks Mastra's client protocol and has no AG-UI route, so a copy written as
     * `remote_ag_ui` would carry the right address and be unable to say anything to it. Which agent on
     * that server comes with it for the same reason: a Mastra endpoint is a roster, and a copy that
     * forgets the name falls back to a different agent, or refuses.
     */
    expect(
      runForDuplicate(
        {
          type: "remote_mastra",
          configuration: {
            endpoint: "http://mastra.invalid",
            remoteAgentId: "remii",
          },
        },
        managed,
      ),
    ).toEqual({
      type: "remote_mastra",
      configuration: {
        endpoint: "http://mastra.invalid",
        remoteAgentId: "remii",
      },
    });
  });
});
