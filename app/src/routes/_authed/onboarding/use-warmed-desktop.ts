import * as React from "react";
import type { WarmedSession } from "@/components/computer/live-screen";
import { openDesktopStream } from "@/lib/computers/screen";

/**
 * A desktop session opened before anybody asked to see one.
 *
 * WHY THIS EXISTS AT ALL, GIVEN `LiveScreen` ALREADY FETCHES ITS OWN. Because of twenty seconds.
 * `openDesktopStream` STARTS the desktop if it is paused and CREATES one if the person has never had
 * one — `screen.ts:115` says so in as many words, and `live-screen.tsx:150-152` puts the first
 * request at twenty seconds or more. Fetching on mount puts that between the person's click and
 * anything appearing, which during onboarding is the whole difference between a screen that feels
 * instant and a spinner they have to sit through on the one screen where they are forming an opinion.
 *
 * So the wizard opens the session while they are still reading the welcome copy, and hands the result
 * down. By the time they reach the demo the frame mounts on a session that is already open, and the
 * twenty seconds happened underneath a paragraph rather than in front of them.
 *
 * This is deliberately NOT the warming effect from `computer-view.tsx:369-383`, and the difference is
 * load-bearing rather than stylistic:
 *
 * - that one is gated on `shot !== null`, meaning a screenshot has already proved a computer exists.
 *   That gate is a bill-safety check — it stops the product paying to wake a desktop nobody will look
 *   at — and there is nothing to protect here, because the screen that consumes this session is one
 *   the person is already on and has already been told about.
 * - that one is gated on the tile being visible and the page being foregrounded. This one runs
 *   regardless, and that is the point: a tab in the background is exactly where this spend should
 *   happen, since nobody is watching it and the twenty seconds cost nothing.
 *
 * Hence no `usePageVisible` and no `IntersectionObserver` here. Both of those exist upstream to avoid
 * work; this is work we want, on purpose, as early as possible.
 */

/** Whether a session is being fetched, is ready, or could not be had. */
export type WarmState = "idle" | "waking" | "ready" | "unavailable";

export type WarmedDesktop = {
  /** What to show while this is happening. Copy, not a spinner — see `COPY.waking`. */
  state: WarmState;
  /** The session, once there is one. Passed straight to `LiveScreen`. */
  session: WarmedSession | null;
};

/**
 * How many times to ask, and how long to wait between asks.
 *
 * Two attempts, not one, because of a failure mode that is documented a screen away: the first
 * request to a desktop that is merely asleep can race it, and the answer is a refusal that resolves
 * itself seconds later. `live-screen.tsx:144-150` handles this by retrying four times with a widening
 * gap; two is enough here because this is an optimisation rather than a dependency. When the attempts
 * run out the wizard still works — `LiveScreen` was handed nothing and fetches for itself with its own
 * four — so the cost of giving up early is a slower screen, and the cost of not giving up is a person
 * watching a spinner for a minute on their first minute.
 *
 * The gap is longer than `LiveScreen`'s 1.5s on purpose. That retry is a spinner the person is already
 * looking at; this one is invisible, running under copy, so there is no reason to spend its budget in
 * a hurry.
 */
const WARM_ATTEMPTS = 2;
const WARM_GAP_MS = 3_000;

/** Cancelled by unmount or by a change of `enabled`, so a stale session cannot land on a new screen. */
export function useWarmedDesktop(enabled: boolean): WarmedDesktop {
  const [state, setState] = React.useState<WarmState>("idle");
  const [session, setSession] = React.useState<WarmedSession | null>(null);

  React.useEffect(() => {
    if (!enabled) return;

    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;

    setState("waking");

    const attempt = (triesLeft: number) => {
      openDesktopStream()
        .then((opened) => {
          if (!live) return;
          setSession({ url: opened.url, authKey: opened.authKey });
          setState("ready");
        })
        .catch(() => {
          if (!live) return;
          if (triesLeft <= 1) {
            /*
             * "unavailable" IS NOT AN ERROR AND IS NOT SHOWN AS ONE.
             *
             * It is the wizard's cue to draw the illustrated story instead, and it carries no message,
             * because the person has not been told a computer was coming — the copy on the welcome
             * screen is about what this product is, not about a screen that is on its way. A
             * deployment with no E2B key should reach the end of onboarding having felt nothing about
             * it, and a sentence about a missing computer is exactly the feeling it would not have.
             */
            setState("unavailable");
            return;
          }
          timer = setTimeout(() => attempt(triesLeft - 1), WARM_GAP_MS);
        });
    };

    attempt(WARM_ATTEMPTS);

    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, [enabled]);

  return { state, session };
}
