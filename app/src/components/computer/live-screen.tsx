import { useEffect, useMemo, useRef, useState } from "react";
import type { ControlState } from "@/lib/computers/control";
import { openDesktopStream, vncUrlFor } from "@/lib/computers/screen";

/**
 * The person's live desktop, as a real VNC stream.
 *
 * WHY THIS IS AN IFRAME AND NOT A CANVAS
 *
 * Everything this component used to do is gone, and deliberately. It opened a websocket to
 * `/api/computers/desktop/stream`, the server captured a JPEG of the desktop per frame through a
 * remote screenshot API and pushed it down, and this file decoded each one with `createImageBitmap`
 * and drew it. Input went back up the same socket, one awaited round trip per event.
 *
 * That architecture could not be fast, and the reason is structural rather than a tuning failure: the
 * frame rate was the platform's round-trip latency, and a person's mouse move was another round trip
 * before the desktop saw it. A click landed a frame and a half after the hand stopped moving, so a
 * person took the wheel, clicked, saw nothing happen, and clicked again. Adding frames would not have
 * helped, because the bottleneck was that a picture cost a round trip at all.
 *
 * So the server hands over a noVNC URL and a per-session password, and E2B's own noVNC page runs in
 * this iframe, speaking RFB straight to the desktop. Only the rectangles that changed are sent, input
 * never passes through this application, and the latency is a property of the network between the
 * browser and the sandbox.
 *
 * Using E2B's `vnc.html` rather than a bundled noVNC client is a real choice, not a shortcut. It means
 * the connection UI a person sees — "reconnecting", "authentication failed", the clipboard, fullscreen,
 * scaling — is noVNC's own, maintained alongside the protocol, rather than ours.
 *
 * The one thing that costs is error reporting. The iframe is cross-origin, so this component cannot
 * read what happens inside it: a rejected password shows noVNC's error panel to the person and says
 * nothing to us. Everything reported through `onProblem` is therefore about OUR half — the desktop
 * being unreachable, asleep, or refusing to start — which is the half that can actually be wrong.
 */
/**
 * Retrying a desktop that would not open.
 *
 * Four attempts with a widening gap, which is roughly a minute of trying. Bounded because the failure
 * this exists for — a person whose desktop is asleep and whose first request raced it — resolves in
 * seconds, while a deployment with no E2B key or no desktop at all never will, and a spinner that never
 * resolves is worse than a sentence somebody can act on.
 */
const RETRY_LIMIT = 4;
const RETRY_GAP_MS = 1_500;

/**
 * A session already fetched, so mounting the frame does not have to wait for one.
 *
 * Passed in by a parent that warmed it while the person was still reading. Fetching on mount instead
 * puts a round trip to a remote machine between their click and seeing anything, and on a paused
 * desktop that round trip is a resume — seconds of blank panel that look like a broken product rather
 * than a slow one.
 */
export type WarmedSession = { url: string; authKey: string };

type Props = {
  /**
   * Which Bot's screen this is being shown for.
   *
   * NOT USED TO ADDRESS THE STREAM, and it is worth being explicit that it is not, because the name
   * invites the opposite assumption. The desktop belongs to a PERSON and there is one address for it.
   * The surrounding view still says which Bot is being watched, so it passes one, and this component
   * simply does not need it.
   */
  computerId: string;
  /**
   * Whether the user currently holds the wheel.
   *
   * IT NOW GATES INPUT, which it deliberately did not for a long time, and the reversal is worth stating
   * because the earlier reasoning was not wrong — it was incomplete.
   *
   * That reasoning was: noVNC is interactive from the moment it connects, the wheel is enforced
   * SERVER-side by `controlHolder`, and gating input here too would leave a person holding the wheel
   * whose clicks went nowhere while a Bot quietly kept driving the same desktop. All true, and all about
   * the "person is driving" state.
   *
   * What it missed is the state people are actually in most of the time: watching. A person watching a
   * Bot work clicks the screen — to scroll, to bring a window forward, to type a URL — and the click
   * lands, because nothing here was in the way. The Bot's own tools are correctly refused while a
   * person holds control, so its next action fails with "a person has control" and its run carries on as
   * if untouched. The person watched their click work. Nothing reported a collision, because the only
   * party who could notice was the one being moved.
   *
   * So while `driving` is false the frame is covered and click-through is impossible, with Take control
   * on the same surface. When it is true there is no overlay at all — the input path is not gated for
   * somebody who has the wheel, it is simply not there.
   */
  driving: boolean;
  /**
   * A session the parent already has, used instead of fetching one.
   *
   * Optional and not a correctness requirement: without it this component fetches for itself, which is
   * slower but identical in outcome. With it, opening the screen is instant.
   */
  session?: WarmedSession | null;
  /** Called with a human-readable reason when the screen cannot be established. */
  onProblem?: (problem: string | null) => void;
  /**
   * Take the wheel, for the overlay's own button.
   *
   * Optional, and optional is a real limit rather than a convenience: without it the overlay still
   * blocks input, and a person who wanted the wheel has to find the button elsewhere on the panel. That
   * is worse than having no overlay, so a caller that can supply this should — but the screen must not
   * depend on it, because a read-only desktop is still correct if the escape hatch is missing.
   */
  takeControl?: () => Promise<ControlState | null>;
  /**
   * Told when this component took the wheel.
   *
   * Separate from `takeControl` because the parent holds the authoritative control state it derives
   * `driving` from; without being told, the overlay would keep covering a desktop this person now owns.
   */
  onControl?: (state: ControlState) => void;
};

export function LiveScreen({
  driving,
  session: warmed,
  onProblem,
  takeControl,
  onControl,
}: Props) {
  const [session, setSession] = useState<{ url: string } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  /*
   * The problem is mirrored into a ref because the fetch effect must not re-run every time it
   * changes: `onProblem` is a fresh closure on every render of the parent, and depending on it would
   * tear down a working screen and re-authenticate it on every unrelated state change above it.
   */
  const reportProblem = useRef(onProblem);
  reportProblem.current = onProblem;

  /*
   * The warmed session is turned into a URL once, here, rather than in the parent.
   *
   * The password is attached at the last possible moment for the same reason it is not in the URL the
   * server returns: a URL with a credential in it ends up in history and in logs. The parent warms the
   * session as data and never builds a URL at all.
   */
  const warmedUrl = useMemo(
    () => (warmed ? vncUrlFor(warmed) : null),
    [warmed],
  );

  useEffect(() => {
    if (warmedUrl) {
      setSession({ url: warmedUrl });
      setProblem(null);
      reportProblem.current?.(null);
      return;
    }
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;

    const fail = (message: string) => {
      if (!live) return;
      setProblem(message);
      setSession(null);
      reportProblem.current?.(message);
    };

    /*
     * Opening the screen STARTS the desktop if it is paused, and CREATES one if the person has never
     * had one — so the first request legitimately takes twenty seconds or more. It can also fail
     * outright, and that used to be final: one attempt, and the screen stayed dead until the component
     * was unmounted and remounted, which for a person means reloading the page. A desktop being asleep,
     * being created, or briefly unable to answer is not the same as a desktop that does not exist, and
     * the two were treated the same way.
     *
     * So a failure is retried a few times with a widening gap, and the reason stays on screen the whole
     * time so the person is watching something that is trying rather than something that has given up.
     * The retries stop: this is not a spinner that never resolves, and after a handful of attempts the
     * sentence on screen is the answer, which is what a person needs to be able to act on.
     */
    const open = async () => {
      try {
        const opened = await openDesktopStream();
        if (!live) return;
        setSession({ url: vncUrlFor(opened) });
        setProblem(null);
        reportProblem.current?.(null);
      } catch (error) {
        if (!live) return;
        const message =
          error instanceof Error
            ? error.message
            : "This computer is not running.";
        // Said immediately, every time, because the parent draws it and a person should never be
        // looking at an unexplained blank panel.
        fail(message);
        if (attempt >= RETRY_LIMIT) return;
        attempt += 1;
        timer = setTimeout(() => void open(), RETRY_GAP_MS * attempt);
      }
    };

    void open();

    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
    // `warmedUrl` is in the dependency list on purpose: a session arriving late must still be used,
    // and that is the whole reason to accept one.
  }, [warmedUrl]);

  /*
   * NO ERROR TEXT OF ITS OWN.
   *
   * It used to be here, and the parent renders the same sentence in the overlay above this component —
   * so a desktop that could not be opened said why TWICE, once here and once there. That is the exact
   * bug `computer-problem-card.test.tsx` exists to catch, and it is worth being explicit that the fix is
   * to report upward and not draw: this component's only job with a failure is to TELL its parent, and
   * the parent already has a surface for it, in a place a person can read it without the panel moving.
   */
  return (
    <div className="relative h-full w-full">
      {session ? (
        <iframe
          /*
           * Full-bleed, because the whole point of `resize=scale` in the URL is for the desktop to be
           * fitted to whatever space this gets — and an iframe letterboxed inside its own panel
           * would undo that, leaving the desktop scaled twice and slightly wrong in both axes.
           */
          className={`h-full w-full border-0 ${driving ? "pointer-events-auto" : "pointer-events-none"}`}
          title="The assistant's screen"
          // The password is in the query string, so `referrerPolicy="no-referrer"` is load-bearing
          // rather than tidy: without it the page E2B serves can see a URL that grants control of
          // somebody's desktop, in its own logs and in anything it loads.
          referrerPolicy="no-referrer"
          // Sandboxed to what a VNC client needs and no more. `allow-scripts` is required for noVNC at
          // all; `allow-same-origin` is required for it to use the clipboard APIs a person would
          // otherwise expect to work. Nothing else is granted — no forms, no top-level navigation, no
          // popups — so a compromised sandbox host cannot turn this frame into a browser.
          sandbox="allow-scripts allow-same-origin allow-pointer-lock allow-clipboard-read allow-clipboard-write"
          src={session.url}
          data-driving={driving}
        />
      ) : problem ? null : (
        <div className="flex h-full w-full items-center justify-center bg-muted text-sm text-muted-foreground">
          <span>Starting the computer…</span>
        </div>
      )}
    </div>
  );
}
