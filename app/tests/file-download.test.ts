import { describe, expect, test } from "bun:test";
import { downloadFileName } from "../src/lib/download";

/**
 * What a saved file lands on disk as.
 *
 * A Bot that invented its own title usually produces one with no extension, and
 * a browser handed `report` writes a file the system cannot open — so the
 * extension is filled in from the type of the text. Getting this wrong is
 * invisible until somebody tries to open what they just downloaded.
 */
describe("downloadFileName", () => {
  test("keeps a name that already has an extension", () => {
    expect(downloadFileName({ name: "eventum-audit.md" })).toBe(
      "eventum-audit.md",
    );
    expect(downloadFileName({ name: "findings.JSON" })).toBe("findings.JSON");
  });

  test.each([
    ["text/markdown", "md"],
    ["application/json", "json"],
    ["text/csv", "csv"],
    ["text/html", "html"],
    ["text/plain", "txt"],
    [null, "txt"],
  ])("adds the extension for %s", (mimeType, expected) => {
    expect(downloadFileName({ name: "report", mimeType })).toBe(
      `report.${expected}`,
    );
  });

  test("a name ending .md is markdown whatever the stored type says", () => {
    // The name is the better evidence of what a file is than a default the Bot
    // chose when it saved it.
    expect(downloadFileName({ name: "notes.md", mimeType: "text/plain" })).toBe(
      "notes.md",
    );
  });

  test("falls back to a usable name when there is none", () => {
    expect(downloadFileName({ name: "   " })).toBe("file.txt");
    expect(downloadFileName({ name: "" })).toBe("file.txt");
  });

  test("keeps the name a person recognises, spaces and all", () => {
    expect(downloadFileName({ name: "Security audit 25 Sep" })).toBe(
      "Security audit 25 Sep.txt",
    );
  });
});
