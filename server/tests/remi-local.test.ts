import { describe, expect, test } from "bun:test";
import { GOG_TOOL_NAMES, gogToolsFor, resolveGogBinary } from "../src/remi/gog";
import { synthesizeSpeech, voiceConfig } from "../src/remi/voice";

/**
 * Local integrations (machine CLI, voice), minus everything external.
 *
 * No binary and no key in this environment — which is exactly the posture under
 * test: every surface reports its own absence with setup words instead of failing. What
 * pins the contract is that shape (tools stay home or answer sentences, never throw) and
 * the router knowing every offered name.
 */

describe("resolveGogBinary", () => {
  test("a configured binary wins when executable", () => {
    expect(resolveGogBinary({ GOG_BINARY: "/bin/sh", PATH: "" })).toBe(
      "/bin/sh",
    );
  });

  test("falls back to PATH, then to nothing", async () => {
    const dir = `${process.env.TMPDIR ?? "/tmp"}/gog-fake-${Date.now()}`;
    await Bun.write(`${dir}/gog`, "#!/bin/sh\necho fake\n");
    const { chmod } = await import("node:fs/promises");
    await chmod(`${dir}/gog`, 0o755);
    expect(resolveGogBinary({ PATH: dir })).toBe(`${dir}/gog`);
    expect(resolveGogBinary({ PATH: "/nonexistent-dir" })).toBeNull();
    expect(resolveGogBinary({})).toBeNull();
  });
});

describe("gog tools", () => {
  test("stay home without a binary", () => {
    expect(gogToolsFor({ binary: null })).toEqual([]);
  });

  test("the router knows every offered name", () => {
    for (const tool of gogToolsFor({ binary: "/bin/sh" })) {
      expect(GOG_TOOL_NAMES as readonly string[]).toContain(tool.name);
    }
    expect(gogToolsFor({ binary: "/bin/sh" })).toHaveLength(
      GOG_TOOL_NAMES.length,
    );
  });

  test("a missing binary reports setup, never throws", async () => {
    const tools = gogToolsFor({ binary: "/nonexistent/gog" });
    const status = tools.find((tool) => tool.name === "gog_status")!;
    const answer = await status.execute({});
    expect(answer).toContain("not found");
  });
});

describe("voice", () => {
  test("absent without a key", () => {
    expect(voiceConfig({})).toBeNull();
  });

  test("synthesis without a key answers null, never throws", async () => {
    await expect(synthesizeSpeech("hello", null)).resolves.toBeNull();
    await expect(
      synthesizeSpeech("", { apiKey: "k", voiceId: "v", model: "m" }),
    ).resolves.toBeNull();
  });
});
