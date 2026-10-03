/**
 * Render the mascot at every size and state the product uses, to a standalone HTML file.
 *
 * WHY THIS EXISTS. Every bug it was written to catch was invisible to a passing test suite: the frame
 * loop writes SVG attributes rather than React state, so nothing about a mascot being a hundred times
 * its intended size shows up in a type check, a unit test, or the DOM. The resting avatar was fine.
 * The animated one was a grey rectangle, and it was only visible by looking at a picture of it.
 *
 * So this drives the real engine through the real `paintBody` / `paintDecor` / `paintNotif`, emits one
 * sheet covering the whole size range, and hands it to `sheet.mjs` to photograph. `visual.test.ts`
 * compares the result against the committed PNG.
 *
 * It reads no project file at runtime and imports nothing but the module under test, so the sheet is
 * a picture of the shipping code and not of a reimplementation of it. That was the one thing that
 * could quietly rot this: an earlier harness hand-transcribed the component's JSX and proved nothing
 * about the component.
 */
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register({ url: "https://remii.test/" });

import type { AIState } from "@/components/agents/orb/ai-core";
import { REMII_AGENT_ID } from "@/lib/agents/default-agent";
import { BotEngine } from "@/mascot/bloub/engine";
import type { BotExpression } from "@/mascot/bloub/expressions";
import type { StateId } from "@/mascot/bloub/states";
import {
  mascotColor,
  mascotExpression,
  mascotExpressionFor,
  mascotFill,
  mascotShapeRadii,
  mascotStateFor,
  restingLoopFor,
} from "@/mascot/ids";
import {
  ARC_POOL_SIZE,
  BALL_RADIUS,
  DOT_POOL_SIZE,
  EYE_POOL_SIZE,
  type MascotNodes,
  paintBody,
  paintDecor,
  paintNotif,
} from "@/mascot/mascot-nodes";
import { mergeMascotChoice, restingExpressionForSeed } from "@/mascot/seed";
import {
  MASCOT_COLOR_IDS,
  type MascotChoice,
} from "../../../shared/mascot-ids";

/** Mirrors `mascot-avatar.tsx`. Kept adjacent to it; see the note about drift at the bottom. */
const ENGINE_SCALE = 100;
const VIEW_BOX_HALF = 130;

interface Tier {
  face: boolean;
  eyeScale: number;
  eyeSplitScale: number;
  decor: boolean;
  sampleEvery: number;
}
const CHIP: Tier = {
  face: false,
  eyeScale: 1,
  eyeSplitScale: 1,
  decor: false,
  sampleEvery: 3,
};
const AVATAR: Tier = {
  face: true,
  eyeScale: 1.2,
  eyeSplitScale: 1.08,
  decor: false,
  sampleEvery: 1,
};
const AVATAR_SMALL: Tier = { ...AVATAR, eyeScale: 1.08 };
const HERO: Tier = { ...AVATAR, eyeScale: 1, eyeSplitScale: 1, decor: true };

function tier(size: number): Tier {
  if (size <= 20) return { ...CHIP };
  if (size < 48) return size >= 28 ? { ...AVATAR } : { ...AVATAR_SMALL };
  return { ...HERO };
}

const NS = "http://www.w3.org/2000/svg";
const makeNode = (tag: string) =>
  document.createElementNS(NS, tag) as SVGElement;

/** Fresh painter nodes. `paintDecor` needs real elements, so they are built rather than faked. */
function makeNodes(): MascotNodes {
  return {
    maskBody: makeNode("path") as SVGPathElement,
    maskEyes: Array.from({ length: EYE_POOL_SIZE }, () =>
      makeNode("path"),
    ) as SVGPathElement[],
    body: makeNode("path") as SVGPathElement,
    dotGroups: Array.from({ length: DOT_POOL_SIZE }, () =>
      makeNode("g"),
    ) as SVGGElement[],
    dotCircles: Array.from({ length: DOT_POOL_SIZE }, () =>
      makeNode("circle"),
    ) as SVGCircleElement[],
    dotPaths: Array.from({ length: DOT_POOL_SIZE }, () =>
      makeNode("path"),
    ) as SVGPathElement[],
    arcFronts: Array.from({ length: ARC_POOL_SIZE }, () =>
      makeNode("path"),
    ) as SVGPathElement[],
    arcBacks: Array.from({ length: ARC_POOL_SIZE }, () =>
      makeNode("path"),
    ) as SVGPathElement[],
    notifDot: makeNode("circle") as SVGCircleElement,
    notifNotch: makeNode("circle") as SVGCircleElement,
  };
}

function growEyes(expression: BotExpression, at: Tier): BotExpression {
  if (at.eyeScale === 1) return expression;
  const [left, right] = expression.eyes;
  const grow = (eye: (typeof expression.eyes)[number]) => ({
    ...eye,
    w: eye.w * at.eyeScale,
    h: eye.h * at.eyeScale,
  });
  return {
    ...expression,
    split: expression.split * at.eyeSplitScale,
    eyes: [grow(left), grow(right)],
  };
}

/** One mascot, painted and read back out as SVG markup the same way the component's nodes are. */
export function renderMascot(options: {
  seed: string;
  choice?: Partial<MascotChoice> | null;
  size: number;
  state?: AIState;
  /** Override the pose entirely, used to walk a mascot through its own resting loop. */
  restingStep?: number;
  /** Seconds since the engine's origin. Chosen per row so states are caught at a legible moment. */
  t: number;
}): string {
  const at = tier(options.size);
  const resolved = mergeMascotChoice(options.choice, options.seed);
  // Mirrors `mascot-avatar.tsx`: the resting face comes from the seed, and the state the row is
  // photographing replaces it. Computed before the engine so it can be its constructor argument,
  // which is where the component hands it over too.
  const resting = restingExpressionForSeed(options.seed);
  const face = mascotExpression(
    options.state ? mascotExpressionFor(options.state, resting) : resting,
  );
  const engine = new BotEngine(
    ENGINE_SCALE,
    "idle",
    mascotShapeRadii(resolved.shape),
    face ?? null,
  );
  if (face) engine.setExpression(growEyes(face, at), 0);

  const want: StateId =
    options.restingStep !== undefined
      ? (restingLoopFor(options.seed).loop[
          options.restingStep % restingLoopFor(options.seed).loop.length
        ] ?? "idle")
      : mascotStateFor(options.state ?? "idle");
  if (want !== "idle") engine.setState(want, 0);
  const frame = engine.sample(options.t);

  const color = mascotFill(resolved.color, options.seed);
  const nodes = makeNodes();
  paintBody(nodes, frame, color, at.face);
  paintDecor(nodes, frame, at.decor, color);
  paintNotif(nodes, frame);

  const id = `m${Math.random().toString(36).slice(2, 9)}`;
  const half = VIEW_BOX_HALF;

  /**
   * `MascotNodes` is typed as nullable because React refs start null. The harness builds its nodes
   * directly, so they never are — one accessor keeps that in one place instead of a null check on
   * every single attribute read below.
   */
  const attr = (node: SVGElement | null, name: string) =>
    node?.getAttribute(name) ?? "";
  const hidden = (node: SVGElement | null) =>
    !node || node.getAttribute("display") === "none";

  const eyeMarkup = nodes.maskEyes
    .filter((n) => !hidden(n))
    .map(
      (n) =>
        `<path fill="#000000" opacity="${attr(n, "opacity")}" d="${attr(n, "d")}" transform="${attr(n, "transform")}"/>`,
    )
    .join("");

  const arcMarkup = (n: SVGPathElement | null) =>
    hidden(n)
      ? ""
      : `<path fill="none" stroke="${attr(n, "stroke")}" stroke-linecap="round" stroke-width="${attr(n, "stroke-width")}" opacity="${attr(n, "opacity")}" d="${attr(n, "d")}"/>`;

  const dotMarkup = nodes.dotCircles
    .map((c, i) => {
      const group = nodes.dotGroups[i];
      if (hidden(group) || hidden(c)) return "";
      const p = nodes.dotPaths[i];
      if (hidden(c) && p && !hidden(p)) {
        return `<path fill="${attr(p, "fill")}" opacity="${attr(p, "opacity")}" transform="${attr(p, "transform")}" d="${attr(p, "d")}"/>`;
      }
      return `<circle fill="${attr(c, "fill")}" opacity="${attr(c, "opacity")}" cx="${attr(c, "cx")}" cy="${attr(c, "cy")}" r="${attr(c, "r")}"/>`;
    })
    .join("");

  const notif = hidden(nodes.notifDot)
    ? ""
    : `<circle fill="#2496e8" cx="${attr(nodes.notifDot, "cx")}" cy="${attr(nodes.notifDot, "cy")}" r="${attr(nodes.notifDot, "r")}"/>`;

  return `<svg width="${options.size}" height="${options.size}" viewBox="${-half} ${-half} ${half * 2} ${half * 2}"
    style="display:block;overflow:hidden">
  <defs><mask id="${id}" maskUnits="userSpaceOnUse" x="${-half * 1.5}" y="${-half * 1.5}" width="${half * 3}" height="${half * 3}">
    <path fill="#ffffff" d="${attr(nodes.maskBody, "d")}"/>
    ${eyeMarkup}
  </mask></defs>
  ${nodes.arcBacks.map((n) => arcMarkup(n)).join("")}
  <path fill="${color}" d="${attr(nodes.body, "d")}" opacity="${attr(nodes.body, "opacity") || 1}" mask="url(#${id})"/>
  ${nodes.arcFronts.map((n) => arcMarkup(n)).join("")}
  ${dotMarkup}
  ${notif}
</svg>`;
}

const SHAPES = [
  "circle",
  "pebble",
  "squircle",
  "capsule",
  "triangle",
  "hexagon",
  "cloud",
] as const;
const STATES: AIState[] = [
  "idle",
  "listening",
  "thinking",
  "streaming",
  "done",
  "error",
];
const T = 2.2;

const css = `
:root{--bg:#fff;--fg:#0a0a0c;--mut:#f4f4f5;--mutfg:#71717a;--line:#e4e4e7}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:13px/1.45 ui-sans-serif,system-ui,sans-serif;padding:24px}
h2{font-size:15px;margin:30px 0 8px}
h3{font-size:12px;color:var(--mutfg);margin:16px 0 6px;font-weight:500}
.row{display:flex;gap:14px;align-items:flex-end;flex-wrap:wrap}
figure{margin:0;text-align:center}
.box{background:var(--mut);border-radius:6px;display:inline-flex;align-items:center;justify-content:center}
.box.col{flex-direction:column;gap:6px;padding:6px}
figcaption{margin-top:5px;font-size:10px;color:var(--mutfg)}
.side{width:250px;border:1px solid var(--line);border-radius:8px;overflow:hidden}
.row-item{display:flex;gap:10px;align-items:center;height:3.25rem;padding:8px;box-sizing:border-box;border-bottom:1px solid #eee}
.av{display:flex;align-items:center;justify-content:center;flex:none}
.txt{display:flex;flex-direction:column;min-width:0}
.txt small{color:var(--mutfg)}
.card{width:210px;height:180px;border-radius:16px;overflow:hidden;background:#fff;border:1px solid var(--line);
  display:inline-flex;flex-direction:column;vertical-align:top;margin-right:14px}
.cardtop{flex:1;min-height:0;display:flex;align-items:center;justify-content:center;background:var(--mut)}
.band{padding:9px 12px;border-top:1px solid var(--line);display:flex;flex-direction:column;gap:3px}
.band small{font-size:11px;color:var(--mutfg);line-height:1.35}
`;

const box = (inner: string) => `<div class="box">${inner}</div>`;

const sizeRow = (size: number, note: string) =>
  `<h3>${size}px — ${note}</h3><div class="row">${SHAPES.map(
    (shape) =>
      `<figure>${box(renderMascot({ seed: "seed", choice: { shape, color: "cream" }, size, t: T }))}<figcaption>${shape}</figcaption></figure>`,
  ).join("")}</div>`;

/**
 * The decor at its peak, which is the only place rings and particles exist at all.
 *
 * Added after the sheet failed to notice a ring stroke a hundred times too wide: every state row
 * sampled `swirl` at t=1.6, by which point its rings have faded out entirely, so the sheet was a
 * picture of exactly the parts that were never broken. A sheet that skips the frame a bug lives in is
 * worse than no sheet, because it looks like coverage.
 *
 * Rings are all this catches, and that limit is worth stating plainly. The OTHER scaling bug — a
 * particle radius multiplied twice — cannot be caught here, because no state this app can reach draws a
 * particle: `swirl` draws only rings, and `thinking` and `alert`, the two that do, are not in the
 * mapping. `mascot-geometry.test.ts` covers it instead, with a tolerance of zero and no browser. That
 * split is deliberate: the picture guards what a picture can see, the numbers guard what it cannot.
 *
 * `swirl` is also what `thinking` and `streaming` map to, so this row is a picture of what a working
 * coworker actually looks like, not of a state the product never reaches.
 */
const decorPeak = (size: number) =>
  [0.15, 0.3, 0.5, 0.8]
    .map(
      (t) =>
        `<figure>${box(
          renderMascot({
            seed: "seed",
            choice: { shape: "circle", color: "cream" },
            size,
            state: "thinking",
            t,
          }),
        )}<figcaption>t=${t}</figcaption></figure>`,
    )
    .join("");

/**
 * The states, with the one colour exception below.
 *
 * `error` draws a blue pip on the shoulder rather than anything red, because a mascot is never an
 * indicator. On a `cream` body that pip is a handful of pixels against a near-white shape, which is the
 * one combination on this sheet where it could not be seen at all — so the `error` cell gets a
 * chromatic body instead. That is also the honest check: it is the row where the eye looks for a colour
 * against the body rather than for the body's own colour.
 */

const stateRow = (size: number, note: string) =>
  `<h3>${note} — ${size}px</h3><div class="row">${STATES.map(
    (state) =>
      `<figure>${box(
        renderMascot({
          seed: "seed",
          choice: {
            shape: "circle",
            // See above: the pip needs a chromatic body behind it to be visible at all.
            color: state === "error" ? "blue" : "cream",
          },
          size,
          state,
          t: 1.6,
        }),
      )}<figcaption>${state}</figcaption></figure>`,
  ).join("")}</div>`;

/** The product's real seeds, so the roster shows what people will actually see. */
const ROSTER_SEEDS = [
  "agent_01HX8QK2M4P",
  "agent_01HX8QK2M4Q",
  "agent_01HX8QK2M4R",
  "agent_01HX8QK2M4S",
  "agent_01HX8QK2M4T",
  "agent_01HX8QK2M4U",
];

/** The real sidebar row, at the real row metrics, for the two avatar sizes the roster has used. */
const roster = [32, 36]
  .map(
    (size) =>
      `<h3>roster row, ${size}px avatar — the real sidebar</h3><div class="side">${ROSTER_SEEDS.map(
        (seed, i) => `
  <div class="row-item"><div class="av" style="width:${size}px;height:${size}px">${renderMascot({ seed, size, t: T + i * 0.3 })}</div>
  <div class="txt"><b>Coworker ${i + 1}</b><small>about something</small></div></div>`,
      ).join("")}</div>`,
  )
  .join("");

/**
 * Six coworkers, each walked to the same point in its OWN loop, which is the only way to see that
 * they differ: rendering them all at a single instant would show six identical postures and prove
 * nothing about the seeding.
 */
const restingVariety = (size: number, note: string) => {
  const steps = Math.max(
    ...ROSTER_SEEDS.map((seed) => restingLoopFor(seed).loop.length),
  );
  return `<h3>${note} — ${size}px</h3><div class="row">${ROSTER_SEEDS.map(
    (seed) => {
      const { loop, holdSeconds } = restingLoopFor(seed);
      return `<figure><div class="box col">${Array.from(
        { length: steps },
        (_, step) => box(renderMascot({ seed, size, restingStep: step, t: T })),
      ).join("")}</div>
      <figcaption>loop: ${loop.join(" → ")}<br>holds ${holdSeconds.toFixed(1)}s</figcaption></figure>`;
    },
  ).join("")}</div>`;
};

const card = (name: string, role: string, seed: string) =>
  `<div class="card"><div class="cardtop">${renderMascot({ seed, size: 104, t: T })}</div>
  <div class="band"><span>${name}</span><small>${role}</small></div></div>`;

export function renderSheet(): string {
  return `<!doctype html><meta charset="utf-8"><style>${css}</style>
<h2>The whole palette</h2>
<h3>every colour the customizer offers, with its hex</h3><div class="row">
  ${MASCOT_COLOR_IDS.map((color) => {
    const hex = mascotColor(color)?.hex ?? "";
    const fill = renderMascot({
      seed: "seed",
      choice: { shape: "circle", color },
      size: 32,
      t: T,
    });
    return `<figure>${box(fill)}<figcaption>${color} ${hex}</figcaption></figure>`;
  }).join("")}
  ${MASCOT_COLOR_IDS.map((color) => {
    const hex = mascotColor(color)?.hex ?? "";
    return `<figure><div class="box" style="background:${hex};width:32px;height:32px"></div><figcaption>swatch</figcaption></figure>`;
  }).join("")}
</div>
<h2>Chip tier — no face</h2>
<h3>14 to 20px</h3><div class="row">${[14, 16, 18, 20]
    .flatMap((size) =>
      SHAPES.slice(0, 4).map(
        (shape) =>
          `<figure>${box(renderMascot({ seed: "s", choice: { shape, color: "cream" }, size, t: T }))}<figcaption>${size}</figcaption></figure>`,
      ),
    )
    .join("")}</div>
${sizeRow(24, "small avatar")}
${sizeRow(32, "avatar")}
${sizeRow(80, "hero")}
<h2>States</h2>
${stateRow(32, "avatar tier")}
${stateRow(104, "hero tier")}
<h2>Decor at its peak — what a working coworker looks like</h2>
<h3>104px, through the swirl</h3><div class="row">${decorPeak(104)}</div>
<h3>80px, through the swirl</h3><div class="row">${decorPeak(80)}</div>
<h2>Roster</h2>${roster}
<h2>Resting loops — each mascot has its own</h2>
${restingVariety(32, "avatar tier")}
${restingVariety(80, "hero tier")}
<h2>Remii — the deployment's own assistant</h2>
<h3>the mascot every installation ships</h3><div class="row">
  ${[16, 24, 32, 36, 48, 104]
    .map(
      (size) =>
        `<figure>${box(renderMascot({ seed: REMII_AGENT_ID, size, t: T }))}<figcaption>${size}px</figcaption></figure>`,
    )
    .join("")}
</div>
<h2>Agent card</h2>
${card("Research Analyst", "Reviews receipts and prepares reimbursement reports.", ROSTER_SEEDS[0]!)}
${card("Expense Manager", "Categories spend and files the reimbursement reports.", ROSTER_SEEDS[2]!)}
`;
}

// Written only when run directly, so importing this from a test has no side effect.
if (import.meta.main) {
  const out = new URL("./sheet.html", import.meta.url).pathname;
  await Bun.write(out, renderSheet());
  console.log(`wrote ${out} (ball radius ${BALL_RADIUS})`);
}
