import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";

/**
 * The mascot, looked at.
 *
 * Every one of the bugs this file was added for was invisible to the rest of the suite. The frame loop
 * writes SVG attributes instead of React state, so a mascot being a hundred times its intended size
 * typechecks, renders, satisfies every a11y assertion and passes every snapshot of the DOM — and looks
 * like a grey rectangle. Only a picture catches that class of thing.
 *
 * Two halves, deliberately:
 *
 * - `visual.test.ts` here photographs the real code and compares it with a committed PNG. It catches
 *   proportion and palette, which no attribute can express.
 * - `mascot-geometry.test.ts` asserts the numeric invariants. It catches the double-scaling directly,
 *   without a browser and without a tolerance, and it is what should fail first.
 *
 * So this file is the one that notices a mascot has become ugly. It needs Chrome, and says so and
 * skips rather than passing quietly when Chrome is absent — a visual test that silently stops running
 * is worse than no visual test, because it looks like coverage.
 */

const HERE = new URL(".", import.meta.url).pathname;
const RENDER = `${HERE}render-sheet.ts`;
const COMPARE = `${HERE}sheet.mjs`;
const CHROME = process.env.SHEET_CHROME ?? "/usr/bin/google-chrome";

function hasChrome() {
  return existsSync(CHROME);
}

describe("the mascot sheet", () => {
  it("matches the committed picture", async () => {
    if (!hasChrome()) {
      console.warn(
        `skipping the mascot visual test: no chrome at ${CHROME}. ` +
          "The geometry tests in mascot-geometry.test.ts still cover the scaling bugs.",
      );
      return;
    }

    // Write the sheet from the shipping code first, so what is compared is what the app renders.
    const rendered = Bun.spawn(["bun", "run", RENDER], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const renderOut = await rendered.exited;
    expect(renderOut).toBe(0);

    const compared = Bun.spawn(["node", COMPARE], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err] = await Promise.all([
      new Response(compared.stdout).text(),
      new Response(compared.stderr).text(),
    ]);
    const code = await compared.exited;
    const report = `${out}${err}`.trim();

    /*
     * Exit code 2 is the photograph saying it cannot take one — no Chrome, no playwright — which is
     * a skip, and it is skipped loudly for the same reason the Chrome check above returns early: a
     * visual test that silently stops running is worse than no visual test, because it looks like
     * coverage. It is a separate code precisely so a missing renderer is never reported as a
     * difference in the mascot.
     */
    if (code === 2) {
      console.warn(`skipping the mascot visual test: ${report}`);
      return;
    }

    // The exit code is the assertion and the report is the message. A bare non-zero code tells nobody
    // what changed, and a string matcher over a multi-line report fails less legibly than printing it.
    if (code !== 0) {
      throw new Error(
        `the mascot sheet no longer matches its committed picture:\n${report}`,
      );
    }
    expect(report.length).toBeGreaterThan(0);
  }, 120_000); // Rasterising and diffing two full-page PNGs is not instant.
});
