import { describe, expect, test } from "bun:test";
import {
  askFirstGuidance,
  InvalidExecutionModeError,
} from "../src/execution-mode";
import { parseExecutionMode } from "../src/config";

/**
 * The execution switch, minus the database.
 *
 * The store itself is exercised against a live database during development (read, write,
 * inherit, invalid rejection); what pins the contract here is the closed set and the
 * directive text, because a typo in either silently changes what every ask-first run is told.
 */

describe("parseExecutionMode", () => {
  test("accepts the closed set, case-insensitively", () => {
    expect(parseExecutionMode("direct")).toBe("direct");
    expect(parseExecutionMode("ask-first")).toBe("ask-first");
    expect(parseExecutionMode("  ASK-FIRST ")).toBe("ask-first");
  });

  test("empty is inherit, not a mode", () => {
    expect(parseExecutionMode(undefined)).toBeNull();
    expect(parseExecutionMode("")).toBeNull();
    expect(parseExecutionMode("   ")).toBeNull();
  });

  test("anything else refuses at start-up rather than silently defaulting", () => {
    expect(() => parseExecutionMode("auto")).toThrow();
  });
});

describe("askFirstGuidance", () => {
  test("routes external actions through ask_person and spares internal work", () => {
    const guidance = askFirstGuidance();
    expect(guidance).toContain("ask_person");
    expect(guidance).toMatch(/remembering|organizing/);
  });
});

describe("InvalidExecutionModeError", () => {
  test("names the choice, not the environment variable", () => {
    const error = new InvalidExecutionModeError("auto");
    expect(error.message).toContain("auto");
    expect(error.message).toContain("ask-first");
  });
});
