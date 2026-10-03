/**
 * Photograph the mascot sheet and compare it against the committed one.
 *
 * Exit 0 on a match, 1 on a difference, 2 if Chrome is not there. `visual.test.ts` reads that, so the
 * failure a person sees is "the mascot sheet changed", not a hundred thousand numbers.
 *
 * WHY THE DIFF RUNS IN CHROME RATHER THAN IN BUN. Comparing two PNGs needs a PNG decoder, and the app
 * has no image dependency and is not going to acquire one for a test. Chrome decodes PNG natively, so
 * the comparison is done with both images drawn into a canvas and the pixels counted there. That also
 * means the tolerance is expressed in a real perceptual unit — how many pixels moved and by how much —
 * rather than in whatever a hand-rolled decoder decided.
 *
 * Run with `--update` to rewrite the committed sheet after an intentional change, and read the
 * resulting PNG before committing it: the whole point of this file is that a person looks at the
 * mascot.
 */
import { existsSync } from "node:fs";
import { chromium } from "/home/harsh/.bun/install/global/node_modules/playwright-core/index.mjs";

const HERE = new URL(".", import.meta.url).pathname;
const SHEET = `${HERE}sheet.html`;
const COMMITTED = `${HERE}sheet.png`;
const CHROME = "/usr/bin/google-chrome";

/** Chrome's own path is a hard dependency of this file. Say so plainly rather than throwing ENOENT. */
if (!existsSync(CHROME)) {
  console.error(
    `chrome not found at ${CHROME}; cannot photograph the mascot sheet`,
  );
  process.exit(2);
}

const update = process.argv.includes("--update");

const browser = await chromium.launch({
  executablePath: CHROME,
  args: [
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--force-color-profile=srgb",
    "--hide-scrollbars",
  ],
});

try {
  const page = await browser.newPage({
    deviceScaleFactor: 2,
    viewport: { width: 1100, height: 900 },
  });
  await page.goto(`file://${SHEET}`);
  await page.waitForTimeout(150);
  const fresh = await page.screenshot({ fullPage: true });

  if (update) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(COMMITTED, fresh);
    console.log(`updated ${COMMITTED} — read it before committing`);
    process.exit(0);
  }

  if (!existsSync(COMMITTED)) {
    console.error(
      `no committed sheet at ${COMMITTED}\n` +
        "run: bun run tests/visual/render-sheet.ts && node tests/visual/sheet.mjs --update",
    );
    process.exit(1);
  }

  const { readFileSync } = await import("node:fs");
  const committed = readFileSync(COMMITTED);

  // Byte equality first: identical encodes mean there is nothing to compare.
  if (Buffer.compare(fresh, committed) === 0) {
    console.log("mascot sheet matches");
    process.exit(0);
  }

  /*
   * Not byte-equal, so the encodes differ — a font hint, a Chrome version, a fractional layout. That
   * is not by itself a mascot change, so the pixels are what get judged.
   *
   * Both images go into a canvas at their natural size. A size difference is reported separately
   * rather than sampled against, because a sheet that got taller has changed the layout and there is
   * no pixel-by-pixel answer worth computing.
   */
  const diff = await page.evaluate(
    async ([a, b]) => {
      const load = (bytes) =>
        new Promise((resolve, reject) => {
          const blob = new Blob([new Uint8Array(bytes)], { type: "image/png" });
          const image = new Image();
          image.onload = () => resolve(image);
          image.onerror = () => reject(new Error("png did not decode"));
          image.src = URL.createObjectURL(blob);
        });
      const [left, right] = await Promise.all([load(a), load(b)]);
      if (left.width !== right.width || left.height !== right.height) {
        return {
          sizeMismatch: true,
          a: [left.width, left.height],
          b: [right.width, right.height],
        };
      }
      const read = (image) => {
        const canvas = document.createElement("canvas");
        canvas.width = image.width;
        canvas.height = image.height;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        ctx.drawImage(image, 0, 0);
        return ctx.getImageData(0, 0, image.width, image.height).data;
      };
      const x = read(left);
      const y = read(right);
      let differing = 0;
      let worst = 0;
      let firstRow = -1;
      for (let i = 0; i < x.length; i += 4) {
        const d = Math.max(
          Math.abs(x[i] - y[i]),
          Math.abs(x[i + 1] - y[i + 1]),
          Math.abs(x[i + 2] - y[i + 2]),
          Math.abs(x[i + 3] - y[i + 3]),
        );
        if (d > 8) {
          differing++;
          if (d > worst) worst = d;
          if (firstRow < 0) firstRow = Math.floor(i / 4 / left.width);
        }
      }
      return {
        sizeMismatch: false,
        differing,
        total: x.length / 4,
        worst,
        firstRow,
        width: left.width,
      };
    },
    [[...committed], [...fresh]],
  );

  if (diff.sizeMismatch) {
    console.error(
      `sheet size changed: committed ${diff.a.join("x")}, now ${diff.b.join("x")}`,
    );
    process.exit(1);
  }

  // A thousand pixels is antialiasing on a rounded corner. A percent is a real change.
  const limit = Math.max(1000, diff.total * 0.002);
  if (diff.differing > limit) {
    console.error(
      `mascot sheet changed: ${diff.differing} of ${diff.total} pixels differ ` +
        `(limit ${Math.round(limit)}), worst channel delta ${diff.worst}, first at row ${diff.firstRow}.\n` +
        "Look at it, then if it is intended: node tests/visual/sheet.mjs --update",
    );
    process.exit(1);
  }

  console.log(
    `mascot sheet matches (${diff.differing} antialiased pixels, within ${Math.round(limit)})`,
  );
} finally {
  await browser.close();
}
