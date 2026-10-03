import { describe, expect, test } from "bun:test";
import {
  createComputerProvider,
  describeComputerIsolation,
  describeHostedIsolation,
  isScopedComputerKey,
  parseScopedComputerKey,
  scopeComputerKey,
} from "../src/computer/provider";
import type { ComputerProvider } from "../src/computer/provider";
import type { ComputerConfig } from "../src/config";

/**
 * The per-Bot provider seam, and what is left of it.
 *
 * This file used to test four providers — the Docker supervisor, the shared local browser, the
 * Kubernetes sandbox and the E2B sandbox — by standing up a fake `agent-computer` over HTTP and
 * asserting request paths, headers and inventory mapping. All four are gone. `createComputerProvider`
 * now throws on purpose, because the only computer this deployment has is a E2B desktop.
 *
 * Thirteen of its cases failed with `createSharedComputerProvider is not defined`, which is the
 * correct outcome for a test whose subject was removed. What that left uncovered was everything the
 * module still exports and the rest of the tree still imports, so that is what this file holds now.
 *
 * The two things asserted below are the two that matter, and neither is about a machine:
 *
 *  - The factory refuses. A provider that is constructible is a provider that can be reached, and
 *    reaching one is how a deployment ends up paying for a computer no database row claims.
 *  - The isolation description reports the truth. It is written to the boot audit trail on every
 *    start, so a deployment that reported "the computer feature is off" while running a working,
 *    billing E2B desktop would be recorded as misconfigured in its own history.
 */

/** A provider is not constructible, whatever the configuration asks for. */
function providerConfigFor(
  provider: NonNullable<ComputerConfig["provider"]>,
): ComputerConfig {
  if (provider === "e2b") {
    return {
      provider: "e2b",
      apiUrl: "https://app.e2b.io/api",
      apiKey: "key",
      computerPort: 6080,
      volumeName: "workspace",
      workspaceMountPath: "/workspace",
    } as ComputerConfig;
  }
  if (provider === "shared") {
    return {
      provider: "shared",
      baseUrl: "http://computer:4100",
      token: "computer-secret",
      allowPrivateHosts: false,
    } as ComputerConfig;
  }
  return {
    provider,
    baseUrl: "http://supervisor:4300",
    supervisorToken: "supervisor-secret",
    token: "computer-secret",
    allowPrivateHosts: false,
  } as ComputerConfig;
}

describe("the legacy per-Bot provider factory", () => {
  test.each(["docker", "shared", "sandbox", "e2b", "e2b"] as const)(
    "refuses %s rather than returning a provider",
    (provider) => {
      expect(() => createComputerProvider(providerConfigFor(provider))).toThrow(
        /no per-Bot computer/i,
      );
    },
  );

  test("the refusal names where the computer actually is", () => {
    // An operator who set COMPUTER_PROVIDER=shared and read this sentence should know what to do.
    let message = "";
    try {
      createComputerProvider(providerConfigFor("shared"));
    } catch (error) {
      message = error instanceof Error ? error.message : "";
    }
    expect(message).toMatch(/hosted desktop/);
    expect(message).toMatch(/provisioner/i);
  });
});

describe("computer isolation description", () => {
  test("describes the computer feature as off when no provider is configured", () => {
    const description = describeComputerIsolation(undefined);
    expect(description.isolation).toBe("off");
    expect(description.note.toLowerCase()).toContain("off");
    expect(description.note.toLowerCase()).not.toContain("shared");
    expect(description.note.toLowerCase()).not.toContain("browser");
  });

  test("describes a per-Bot provider's machine isolation", () => {
    const provider = {
      isolation: "per-bot",
      name: "any",
    } as unknown as ComputerProvider;
    expect(describeComputerIsolation(provider).isolation).toBe(
      "one computer per Bot",
    );
  });

  test("describes a per-user provider as one computer per person, not per Bot", () => {
    // One per PERSON is a different boundary from one per Bot, and the sentence says so: two Bots of
    // the same owner share a machine and a memory ceiling, while two people never meet.
    const provider = {
      isolation: "per-user",
      name: "any",
    } as unknown as ComputerProvider;
    const description = describeComputerIsolation(provider);
    expect(description.isolation).toBe("one computer per user");
    expect(description.note).toMatch(/person/i);
  });

  test("keeps a warning on a shared provider", () => {
    const provider = {
      isolation: "shared",
      name: "any",
    } as unknown as ComputerProvider;
    expect(describeComputerIsolation(provider).isolation).toBe(
      "one shared computer",
    );
    expect(describeComputerIsolation(provider).warning).toBeTruthy();
  });
});

describe("the E2B desktop isolation description", () => {
  test("never claims the computer feature is off", () => {
    /*
     * The bug this guards. A E2B desktop is not a `ComputerProvider`, so it used to arrive here
     * as `undefined` and be described as "The computer feature is off" — on a deployment with a
     * working, billing desktop. Both scopes must avoid that sentence.
     */
    for (const scope of ["per-bot", "per-person"] as const) {
      const description = describeHostedIsolation(scope);
      expect(description.isolation).not.toBe("off");
      expect(description.note).not.toMatch(/feature is off/i);
    }
  });

  test("says what each scope separates", () => {
    expect(describeHostedIsolation("per-bot").isolation).toBe(
      "one computer per Bot",
    );
    expect(describeHostedIsolation("per-person").isolation).toBe(
      "one computer per user",
    );
  });

  test("the per-person note admits that the Bots share one screen", () => {
    // The honest part: with one desktop per person, a person watching one Bot is watching the machine
    // every one of their Bots acts on. Saying otherwise is how somebody concludes their Bots are
    // isolated from each other.
    expect(describeHostedIsolation("per-person").note).toMatch(
      /same screen|screen/i,
    );
  });
});

describe("the scoped computer key", () => {
  test("is recognised as scoped and round-trips its slugs", () => {
    const key = scopeComputerKey("user-1234", "bot-5678");
    expect(isScopedComputerKey(key)).toBe(true);
    expect(parseScopedComputerKey(key)).toEqual({
      ownerSlug: "user-1234",
      botSlug: "bot-5678",
    });
  });

  test("keeps two users of the same Bot apart", () => {
    expect(scopeComputerKey("alice", "bot-1")).not.toBe(
      scopeComputerKey("bob", "bot-1"),
    );
  });

  test("keeps two Bots of the same user apart", () => {
    expect(scopeComputerKey("alice", "bot-1")).not.toBe(
      scopeComputerKey("alice", "bot-2"),
    );
  });

  test("separates pairs that slug alike but are not the same", () => {
    // Punctuation and case collapse under the slugger, so the trailing pair hash is what stops
    // "Team Bot" and "team-bot" landing on one computer.
    expect(scopeComputerKey("alice", "Team Bot")).not.toBe(
      scopeComputerKey("alice", "team-bot"),
    );
  });

  test("is stable, because it is recomputed on every lookup", () => {
    expect(scopeComputerKey("alice", "bot-1")).toBe(
      scopeComputerKey("alice", "bot-1"),
    );
  });

  test("carries a full owner slug, so a user's disk is not stranded by truncation", () => {
    const longOwner = "a".repeat(40);
    expect(
      parseScopedComputerKey(scopeComputerKey(longOwner, "bot-1")),
    ).toEqual({ ownerSlug: longOwner, botSlug: "bot-1" });
  });

  test("refuses a legacy key rather than inventing slugs for it", () => {
    expect(isScopedComputerKey("bot-1")).toBe(false);
    expect(parseScopedComputerKey("bot-1")).toBeNull();
  });

  test("carries only characters a Docker, Kubernetes and E2B name all accept", () => {
    // The supervisor accepted ^[A-Za-z0-9][A-Za-z0-9_-]*$, and E2B and Kubernetes agree; the key
    // starts with a letter and never emits a double underscore inside a slug.
    for (const owner of [
      "alice",
      "a b",
      "A/B",
      "user@example.com",
      "x".repeat(80),
    ]) {
      for (const bot of ["bot-1", "Bot Two", "b"]) {
        const key = scopeComputerKey(owner, bot);
        expect(key).toMatch(/^[a-z0-9][a-z0-9_-]*$/);
        expect(key.split("__")).toHaveLength(3);
      }
    }
  });
});
