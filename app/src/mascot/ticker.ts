/**
 * One animation frame loop for every mascot in the app.
 *
 * The obvious implementation gives each avatar its own `requestAnimationFrame`, and with a sidebar
 * of live mascots that is thirty callbacks a frame each rebuilding a 64-point path string. Measured
 * on the agents grid it is the difference between a smooth roster and a laptop fan.
 *
 * So: one loop, a set of subscribers, and a single clock. `BotEngine.sample(t)` is a pure function of
 * `t`, which is what makes this legal — every avatar asked for the same instant produces the same
 * image it would have produced from its own loop, so sharing the loop costs nothing but the ability
 * to run at two different rates.
 *
 * A module singleton rather than a React context, deliberately. Mascots render in portals, in dialogs
 * and inside query-driven lists, and a context would force a provider around all of them for no gain
 * over a module that anybody can import.
 *
 * The loop is not always on. It starts when the first mascot subscribes, stops when the last one
 * leaves, and pauses again when the tab is hidden — nobody is looking at a background tab, and rAF is
 * already throttled there, so stopping outright is the difference between a few wakeups a second and
 * none.
 */

/** Subscribers get seconds since the page's time origin, never a delta. */
type TickListener = (now: number) => void;

const listeners = new Set<TickListener>();

let frameHandle: number | null = null;

/**
 * Target frame rate.
 *
 * 30 rather than 60, and the reason is that nothing here reads as sluggish at half rate: a body
 * breathing at 30fps is indistinguishable from one breathing at 60 to anyone not measuring, while the
 * cost of `sample()` is linear in frames. Halving the rate halves the work for no visible change.
 *
 * Not a per-subscriber option. A second ticker at a different rate would reintroduce exactly the
 * problem this file exists to solve, and nothing here needs one — see `levelOfDetail` in
 * `mascot-avatar.tsx`, which decides how often an avatar is *sampled* without needing its own loop.
 */
const FRAME_BUDGET_MS = 1000 / 30;

let lastRanAt = 0;

/**
 * A whole frame is skipped when the previous one landed less than `FRAME_BUDGET_MS` ago.
 *
 * rAF fires at the display rate, so this is what turns a 120Hz panel's worth of callbacks into the
 * budget above.
 *
 * The skipped frame **still reschedules**, and that is the whole subtlety. Returning without asking
 * for another frame ends the loop for good: on a 60Hz display the very first two callbacks fall
 * inside the budget, the loop stops before it has ever painted anything, and every mascot in the
 * product sits on one frozen frame. Nothing throws and nothing renders wrong — the avatars are simply
 * still, which is the hardest version of this bug to notice.
 *
 * Rescheduling rather than setting a timer, because the loop is already being called at the display
 * rate and a timer would only add a second clock to be out of step with the first.
 */
function runFrame(now: number) {
  frameHandle = null;

  if (now - lastRanAt < FRAME_BUDGET_MS) {
    if (listeners.size > 0 && !isHidden()) schedule();
    return;
  }
  lastRanAt = now;

  // Copied before iterating: a listener may unsubscribe itself, which happens whenever an avatar
  // leaves the roster from inside its own tick, and iterating the live set would skip the next one.
  for (const listener of [...listeners]) listener(now);

  if (listeners.size > 0 && !isHidden()) schedule();
}

function schedule() {
  if (frameHandle === null) frameHandle = requestAnimationFrame(runFrame);
}

function stop() {
  if (frameHandle !== null) {
    cancelAnimationFrame(frameHandle);
    frameHandle = null;
  }
  lastRanAt = 0;
}

function isHidden() {
  return (
    typeof document !== "undefined" && document.visibilityState === "hidden"
  );
}

/**
 * Start ticking. Idempotent, and safe to call from anywhere — it is what makes a mascot work with no
 * provider mounted above it.
 */
function start() {
  if (typeof requestAnimationFrame === "undefined") return;
  if (document.visibilityState === "hidden") {
    document.addEventListener("visibilitychange", onVisibilityChange);
    return;
  }
  document.removeEventListener("visibilitychange", onVisibilityChange);
  schedule();
}

/**
 * Coming back to a hidden tab resumes rather than restart: the clock is absolute, so an avatar that
 * was unsubscribed for a minute samples at `now` and lands on the right frame with no catch-up.
 */
function onVisibilityChange() {
  if (document.visibilityState === "hidden") {
    stop();
    return;
  }
  if (listeners.size > 0) {
    lastRanAt = 0;
    schedule();
  }
}

/**
 * Subscribe to the shared clock. The returned function unsubscribes.
 *
 * `lastRanAt` is reset on the way in so a mascot that mounts 200ms after the last frame does not wait
 * a full budget to appear — an avatar that pops in a third of a second late reads as a lag on the
 * whole page rather than on the mascot.
 */
export function subscribeToTicker(listener: TickListener): () => void {
  if (listeners.size === 0) lastRanAt = 0;
  listeners.add(listener);
  start();

  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      stop();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    }
  };
}

/** How many mascots are currently animating. Exported for tests, not for production reads. */
export function tickerSubscriberCount(): number {
  return listeners.size;
}
