import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui/button";
import {
  type ControlState,
  readControl,
  releaseControl,
  supplySecret,
  takeControl,
} from "@/lib/computers/control";
import {
  openDesktopStream,
  readPageFrame,
  readScreenshot,
  type Screenshot,
} from "@/lib/computers/screen";
import { ChannelAvatar } from "../channels/avatar";
import { LiveScreen, type WarmedSession } from "./live-screen";
import { useElementVisible, usePageVisible } from "./preview-visibility";

/** Explicit blank-browser URLs use placeholder artwork; missing URL fields are treated as real pages. */
function isBlankBrowser(shot: Screenshot): boolean {
  if (shot.url === undefined) return false;
  const url = shot.url.trim();
  return url === "" || url === "about:blank";
}

/** The part of a URL worth putting on screen; the whole thing is rarely readable at this size. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * What each finished turn opened, and the frame it ended on, kept outside any component.
 *
 * MODULE SCOPE, BECAUSE THE TILE DOES NOT SURVIVE. A transcript re-renders freely and remounts the
 * tiles in it, and anything held in component state goes with it: the fresh mount has no page yet,
 * behaves for one render like a live turn, and reaches for the live screen. Keyed on the tool call,
 * which is the identity of the turn rather than of the component drawing it.
 *
 * Bounded, because a long conversation is a lot of screenshots. Oldest out first, and a turn whose
 * frame has been dropped falls back to naming its page.
 */
type RememberedTurn = {
  page?: { url?: string; title?: string };
  frame?: { base64: string; url: string };
  /** Whether the server has already been asked, so a turn with no frame is not asked again. */
  asked?: boolean;
};
const REMEMBERED_TURNS = new Map<string, RememberedTurn>();
const MAX_REMEMBERED_TURNS = 40;

function rememberTurn(toolCallId: string, patch: RememberedTurn): void {
  const existing = REMEMBERED_TURNS.get(toolCallId) ?? {};
  /*
   * A FRAME IS WRITTEN ONCE, which is what the server's own insert says and what this has to agree
   * with. Letting a later write win is exactly what went wrong: the tile restored the right frame and
   * then replaced it, one render later, with a screenshot of whatever the Bot had open by then.
   */
  const merged: RememberedTurn = { ...existing, ...patch };
  if (existing.frame) merged.frame = existing.frame;
  REMEMBERED_TURNS.delete(toolCallId);
  REMEMBERED_TURNS.set(toolCallId, merged);
  while (REMEMBERED_TURNS.size > MAX_REMEMBERED_TURNS) {
    const oldest = REMEMBERED_TURNS.keys().next().value;
    if (oldest === undefined) break;
    REMEMBERED_TURNS.delete(oldest);
  }
}

/** Default browser viewport ratio, reserved before the first screenshot arrives. */
const DEFAULT_ASPECT_RATIO = 1280 / 800;

/** Minimum readable inline screen size. */
const DEFAULT_MIN_WIDTH = 320;
const DEFAULT_MIN_HEIGHT = 200;

/** Preload without failing the poll loop when a frame cannot be decoded early. */
async function preloadFrame(base64: string): Promise<void> {
  try {
    const image = new Image();
    image.src = `data:image/png;base64,${base64}`;
    await image.decode();
  } catch {
    // Let the visible image element handle decode failures.
  }
}

/** Identical frames in a row that mean the page has stopped changing. */
const SETTLED_FRAMES = 3;

/** Hard cap for post-action polling on pages that never settle. */
const SETTLE_TIMEOUT_MS = 30_000;

/** Short confirmation window after a secret is sent to the page. */
const SECRET_CONFIRM_MS = 6_000;

/**
 * What the frame says when there is no picture in it.
 *
 * Shared by the card and the full-size view because it is the same fact at either size, and because
 * the full-size view is now reachable with nothing to draw: the wheel lives down there, so a person
 * whose Bot is looking at a blank browser — or whose screen cannot be read at all — has to be able
 * to open it and be told why it is empty, rather than find a disabled frame and no way in.
 */
function NothingToSee({
  problem,
  blankBrowser,
  settled,
  page,
}: {
  problem: string | null;
  blankBrowser: boolean;
  /** Whether this is a turn that has finished, rather than the browser as it is now. */
  settled?: boolean;
  /** The page that turn opened, named when there is no picture of it. */
  page?: { url?: string; title?: string } | undefined;
}) {
  return (
    <span className="absolute inset-0 flex flex-col items-center justify-center gap-1 p-4 text-center text-muted-foreground text-sm">
      {settled ? (
        <>
          {/*
            What this turn had open, named rather than drawn.

            The picture is gone: nothing stored it, and fetching one now would show a different page.
            Naming the page is the honest version of the same sentence, and it stays true however
            many times the Bot has browsed since.

            GATED ON THE TURN BEING OVER, not on whether a live frame happens to be in hand. A tile
            that was live a moment ago keeps its last screenshot in state after it settles, and this
            used to check for that: with one held and no frame stored, it fell through to "Waiting
            for the assistant's screen…" and waited there for ever, because the poll that would have
            ended the wait stops the moment a turn settles.
          */}
          {page?.url ? (
            <>
              <span className="font-medium">{page.title || "A page"}</span>
              <span className="break-all">{hostOf(page.url)}</span>
              <span>
                Opened during this turn. The screen has moved on since.
              </span>
            </>
          ) : (
            /*
             * A turn that ended without getting anywhere: refused by a boundary, stopped, or failed.
             * Saying "opened during this turn" here would describe something that did not happen.
             */
            <span>This turn did not open a page.</span>
          )}
        </>
      ) : problem ? (
        /*
         * ONE SENTENCE, and it is the one that was written for this exact moment.
         *
         * `problem` arrives as a finished, specific sentence from whoever set it — "This computer is
         * not running.", "The live screen could not be reached." — and every branch here is a single
         * line saying the thing once. This one wrapped it in a headline and a footer as well, which
         * did not merely repeat itself but said the opposite twice over: a person whose desktop had
         * stopped read "This computer is not running." and then, underneath, "Check whether its
         * computer is running." Three sentences, one fact, and the last one undoing the middle.
         *
         * So the reason is shown as written. If it needs a heading above it, the sentence that sets
         * it is where that belongs — the server knows what went wrong, and this card does not.
         */
        <span>{problem}</span>
      ) : blankBrowser ? (
        <span>The assistant has not opened a page yet.</span>
      ) : (
        <span>Waiting for the assistant's screen…</span>
      )}
    </span>
  );
}

type Props = {
  /** Which computer to watch. One shared computer unless each Bot has been given its own. */
  computerId: string;
  /** Off by default so idle Bot screens do not poll indefinitely. */
  active?: boolean;
  intervalMs?: number;
  /** Width divided by height. Overridable for a Bot whose computer is not the default shape. */
  aspectRatio?: number;
  minWidth?: number;
  minHeight?: number;
  /** Whose screen this is, drawn as a small badge over the frame. Absent, no badge is drawn. */
  name?: string;
  /**
   * The page this turn left the browser on, for a turn that has finished.
   *
   * A conversation is a record, and a record must not change its mind. Without this, reopening a
   * conversation made every past turn fetch the screen as it is now, so an answer about Hacker News
   * from an hour ago sat under a picture of whatever the Bot has open today. The frame was live, the
   * caption was not, and the turn read as though it had browsed somewhere it never went.
   */
  page?: { url?: string; title?: string };
  /**
   * Whether the turn this tile belongs to has ended.
   *
   * SEPARATE FROM HAVING A PAGE. A navigation that was refused, failed or stopped ends without one,
   * and a tile that decided history by "do I have a page" left exactly those turns polling the live
   * screen for ever, under an answer that had nothing to do with what was on it.
   */
  finished?: boolean;
  /**
   * The tool call this tile belongs to, which is what a kept frame is filed under.
   *
   * Without it the tile can still name the page; with it, it can show the page. Optional because the
   * side panel is not a turn and has nothing to remember.
   */
  toolCallId?: string;
  /**
   * Whether a run is going right now, for a panel that is watching rather than replaying.
   *
   * THIS IS THE WHOLE OF "the small screen is stuck on one frame".
   *
   * The watch panel is not a turn. It has no `toolCallId`, so `settled` is false for as long as it is
   * open, and `showLiveScreen` therefore came down to `showScreen` — which requires a still frame to have
   * arrived. Until one did, the panel drew nothing; once one did, it drew THAT one, forever. The panel
   * was showing a screenshot captured at some arbitrary moment and polling the shared desktop at 1 Hz,
   * which is a picture of a screen rather than the screen: it lagged behind what the Bot was doing by up
   * to a second, it could not show a drag or a scroll mid-gesture, and it was labelled with the Bot's
   * name while actually depicting whatever the person's one shared desktop was showing.
   *
   * With this, a watching panel shows the LIVE STREAM while a run is going — noVNC over RFB, the same
   * surface the full-size view uses and the same one a person drives — and falls back to the still poll
   * when nothing is. That is what "it should move according to what the Bot is working on" means in
   * practice: the panel is not sampling the desktop, it is attached to it.
   *
   * Distinct from `active`, deliberately. `active` means "keep polling", which a panel always wants; this
   * means "something is happening right now", which it has to be told and which changes what is drawn.
   */
  followingRun?: boolean;
  /**
   * A session somebody opened earlier, adopted rather than fetched again.
   *
   * OPTIONAL AND NOT A CORRECTNESS REQUIREMENT — without it this component warms its own, the effect below,
   * and the screen is slower and identical in outcome. It exists for the one caller whose screen the person
   * was already looking at a while before they got here: the onboarding wizard opens the desktop while they
   * read the welcome copy, because `openDesktopStream` STARTS a paused desktop and CREATES one that has
   * never existed, and `live-screen.tsx` puts that first request at twenty seconds or more. Waiting for
   * this component's own warming to get there would put those twenty seconds between the person's click
   * and anything appearing, on the one screen where they are forming an opinion of the product.
   *
   * ADOPTED AND NOT READ THROUGH. The value is copied into state when it changes, because `LiveScreen`
   * attaches to a session once and must not be re-pointed at a new one mid-handshake. A parent that
   * re-created this object on every render would attach, detach and attach again forever, which is worse
   * than never passing it — so a caller passes the same object for the life of the screen.
   */
  session?: WarmedSession | null;
};

export function ComputerView({
  computerId,
  active = true,
  intervalMs = 1000,
  aspectRatio = DEFAULT_ASPECT_RATIO,
  minWidth = DEFAULT_MIN_WIDTH,
  minHeight = DEFAULT_MIN_HEIGHT,
  name,
  page,
  finished,
  toolCallId,
  followingRun = false,
  session: adoptedSession,
}: Props) {
  const [shot, setShot] = useState<Screenshot | null>(null);
  /*
   * TWO problems, not one, and they used to be one.
   *
   * The still-frame poll and the live screen are independent: one reads a screenshot every few seconds,
   * the other opens a noVNC stream. Either can fail while the other works, and when they shared a
   * `problem` the LAST writer won — so a healthy screenshot arriving after the live screen reported a
   * failure wiped it, and a person who pressed "Take control", got nothing, and was shown no reason for
   * it. The race decided it, and it decided it differently depending on which request came back first.
   *
   * Kept apart so each surface's own state can only clear itself. {@link problem} is what is drawn: the
   * live screen's reason first, because it is the more specific of the two and the one the person acted
   * on, and the still frame's below it.
   */
  const [frameProblem, setFrameProblem] = useState<string | null>(null);
  const [liveProblem, setLiveProblem] = useState<string | null>(null);
  const problem = liveProblem ?? frameProblem;
  /** A screen session fetched ahead of the person asking for it. See the warming effect below. */
  const [warmedSession, setWarmedSession] = useState<WarmedSession | null>(
    null,
  );
  const [expanded, setExpanded] = useState(false);
  const [control, setControl] = useState<ControlState | null>(null);
  /** Held only until it is sent. Never lifted into a URL, a log, or anything that outlives this form. */
  const [secret, setSecret] = useState("");
  const [secretProblem, setSecretProblem] = useState<string | null>(null);
  const [sendingSecret, setSendingSecret] = useState(false);
  const pageVisible = usePageVisible();
  const [previewRef, previewIntersecting] = useElementVisible<HTMLElement>();
  const driving = control?.holder === "human";
  /** Read by the polling loop without restarting it on control changes. */
  const drivingRef = useRef(false);
  drivingRef.current = driving;

  /** Release control; the Bot's waiting tool call resumes from this state change. */
  const handBack = async () => {
    const state = await releaseControl(computerId);
    if (state) setControl(state);
  };
  /** Secret prompts keep the screen live even though the human does not hold the wheel. */
  const secretPending = Boolean(control?.secretWanted);
  const secretPendingRef = useRef(false);
  secretPendingRef.current = secretPending;
  // Held in a ref so a slow response cannot overwrite a newer frame after the component moved on.
  const generation = useRef(0);
  /** Force a short watch window after non-Bot actions such as secret entry. */
  const watchUntil = useRef(0);

  /**
   * A finished turn is history, and history is not polled.
   *
   * While a turn runs, the frames are that turn's own and freeze where it left them, which is right.
   * Reopening the conversation later is the case this guards: the component mounts with no frame,
   * and fetching one would put today's page under yesterday's answer. It shows the page that turn
   * actually left open instead, which is the thing being remembered.
   *
   * `page` is what marks a turn as settled history rather than one still going, so a caller that
   * knows nothing about the page keeps the old behaviour and nothing regresses.
   *
   * DELIBERATELY NOT "AND WE HAVE NO FRAME YET". That is what this said first, and it undid itself:
   * restoring the kept frame set the frame, which made the turn stop counting as history, which
   * restarted the polling this exists to prevent, which replaced the restored picture with the live
   * one. The turn being over is the fact; whether a picture has arrived yet is not.
   */
  if (toolCallId && page?.url) rememberTurn(toolCallId, { page });
  const knownPage =
    page?.url !== undefined
      ? page
      : toolCallId
        ? REMEMBERED_TURNS.get(toolCallId)?.page
        : undefined;
  const keptFrame = toolCallId
    ? (REMEMBERED_TURNS.get(toolCallId)?.frame ?? null)
    : null;
  /** Bumped when a frame arrives, because the store it lands in is not React state. */
  const [, setFrameArrived] = useState(0);

  const settled = !active && (finished || Boolean(knownPage));
  const visualVisible = pageVisible && (expanded || previewIntersecting);
  /**
   * Whether this person demonstrably HAS a computer, as opposed to never having asked for one.
   *
   * The gate for warming the screen below, and it is a real gate: without it, scrolling past a
   * transcript would create a machine for every Bot with a computer tile in it — a bill for something
   * nobody looked at.
   */
  const computerExists = shot !== null;

  /*
   * THE SESSION IS FETCHED BEFORE IT IS NEEDED, because "take control" should be instant.
   *
   * Opening the screen is a round trip to a remote machine, and on a desktop that has gone to sleep it
   * is a RESUME — several seconds of blank panel between a person clicking and seeing anything. That
   * reads as a broken product rather than a slow one, and it lands on the one gesture that is supposed
   * to feel like taking hold of something.
   *
   * So it is fetched while the person is still reading and handed to the screen when it mounts.
   * Deliberately gated on three things:
   *
   *  - a turn is actually RUNNING, because that is the only state where the still-frame poll runs and so
   *    the only state where this process knows a computer exists. Warming on a finished turn would mean
   *    asking the server whether one exists, and a turn that never asked for a computer would be handed
   *    one by the act of somebody scrolling past it;
   *  - the tile is actually visible, so an off-screen tile costs nothing;
   *  - the person is not already driving, because opening a screen is a request to USE the computer and
   *    a tile nobody is watching should not be the thing that switches it on.
   *
   * The gap this leaves is the one that matters least: a person who has never run a turn on their
   * computer and takes the wheel on a finished tile waits the round trip once, which is the honest cost
   * of starting a machine for the first time. Everyone else — the Bot is working, the screen has been
   * open before — is already warm.
   *
   * Failures are SILENT here on purpose. This is an optimisation; the screen reports properly when it
   * fetches for real, and reporting here would paint an error over a transcript for a failure nobody
   * asked about.
   */
  /*
   * Whether this surface already holds a session, and the two ways it can come to hold one.
   *
   * Declared here because it is a DEPENDENCY of the warming effect below and not merely a convenience
   * for the line after it: a dependency array is evaluated while the component body is still running, so
   * a `const` declared after the `useEffect` that reads it is a reference to an uninitialised binding
   * and the screen throws on its first render rather than failing quietly somewhere useful.
   */
  const warmed = warmedSession !== null;

  useEffect(() => {
    // `settled` first: it is the cheapest statement of "there is a running turn", and it is the state
    // in which the still-frame poll — the only thing that can tell us a computer exists — is running.
    //
    // `warmed` is last for the opposite reason: a screen that already holds a session has nothing to
    // warm, and re-asking would attach, detach and attach again rather than save anything.
    if (driving || settled || !computerExists || !visualVisible || warmed)
      return;
    let live = true;
    void openDesktopStream()
      .then((opened) => {
        if (live)
          setWarmedSession({ url: opened.url, authKey: opened.authKey });
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [driving, settled, computerExists, visualVisible, warmed]);

  /*
   * A session somebody opened before this surface mounted, taken as-is.
   *
   * ADOPTED RATHER THAN READ THROUGH, and that is the whole reason this is an effect instead of
   * `session ?? warmedSession` at the point of use. `LiveScreen` attaches to a session once, inside its
   * own effect keyed on the URL; handing it a new object that is equal in value re-runs that attach,
   * and a parent that built this object during render would hand it a new one every render. Copying it
   * into state on identity makes the prop mean "here is a session, once", which is what a caller
   * warming a screen in the background actually has.
   *
   * Never cleared afterwards. A parent that loses its session — a wizard leaving, say — must not take a
   * live desktop away from a screen that is still driving one, and this component's own warming has
   * already been skipped because it saw one.
   */
  useEffect(() => {
    if (adoptedSession) setWarmedSession(adoptedSession);
  }, [adoptedSession]);

  /*
   * The frame this turn's page was showing, fetched once and then kept.
   *
   * A READ, AND ONLY A READ. The tile used to capture the frame itself once the turn went inactive,
   * and it kept filing the wrong picture: a reopened turn and one that has just finished look
   * identical from in here, the same computer is driven by other conversations between the two, and
   * a resumed computer starts blank. The frame is now taken on the server the moment the navigation
   * succeeds, which is the one moment the screen is certainly showing the page that was asked for,
   * so there is nothing left here to race.
   */
  useEffect(() => {
    if (!toolCallId || !settled) return;
    const remembered = REMEMBERED_TURNS.get(toolCallId);
    /*
     * Asked once per turn, answer or not. Without remembering the empty answer, every turn from
     * before this shipped refetched nothing on every remount, which on a long transcript is one
     * pointless request per turn per scroll.
     */
    if (remembered?.frame || remembered?.asked) return;
    let current = true;

    void (async () => {
      const stored = await readPageFrame(computerId, toolCallId);
      if (!current) return;
      rememberTurn(toolCallId, {
        asked: true,
        ...(stored ? { frame: { base64: stored.frame, url: stored.url } } : {}),
      });
      if (stored) setFrameArrived((n) => n + 1);
    })();

    return () => {
      current = false;
    };
  }, [computerId, toolCallId, settled]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `secretPending` intentionally restarts settled polling.
  useEffect(() => {
    if (settled) return;
    if (!visualVisible) return;
    const mine = ++generation.current;
    let timer: ReturnType<typeof setTimeout>;
    // Consecutive identical frames observed during post-action settling.
    let unchanged = 0;
    let lastFrame = "";
    const graceStartedAt = Date.now();

    /** Continue while active, human-driven, secret-pending, or not yet visually settled. */
    const shouldContinue = () => {
      /*
       * `active` IS "KEEP POLLING", AND TWO MOUNTS RELY ON IT BEING EXACTLY THAT.
       *
       * The Settings preview has no run to ask about — its whole claim is "this is your computer, right
       * now" — so `active` is the only thing that keeps its still current. Collapsing `active` into
       * "the Bot is working" would quietly turn that page into a single unchanging capture.
       *
       * WHICH IS WHY THE WATCH PANEL NO LONGER SETS IT, and the distinction is the point. The panel's
       * `active` was doing two unrelated jobs at once: keeping the CONTROL poll alive, which it genuinely
       * needs (a Bot that goes to sleep between turns must still be noticed asking for a credential), and
       * keeping the SCREENSHOT poll alive, which is a full-resolution capture of a shared machine once a
       * second for as long as a person watches an idle conversation. Only the first is needed. The route
       * therefore passes `followingRun` and leaves `active` off, so the still is fetched once and the
       * live stream carries everything that actually moves.
       */
      if (followingRun) return true;
      if (active) return true;
      if (drivingRef.current) return true;
      if (secretPendingRef.current) return true;
      if (Date.now() < watchUntil.current) return true;
      if (Date.now() - graceStartedAt > SETTLE_TIMEOUT_MS) return false;
      return unchanged < SETTLED_FRAMES;
    };

    // Always fetch at least one frame; only repeated refreshes are conditional.
    const tick = async () => {
      try {
        const { frame, error } = await readScreenshot(computerId);
        if (generation.current !== mine) return;

        if (!frame) {
          setFrameProblem(error ?? "The screen is not available right now.");
        } else {
          // Exact byte comparison is the settling signal.
          unchanged = frame.base64 === lastFrame ? unchanged + 1 : 0;
          lastFrame = frame.base64;
          // Decode before swapping to avoid blanking the visible image during data URL changes.
          await preloadFrame(frame.base64);
          if (generation.current !== mine) return;
          setShot(frame);
          // Clears the FRAME's problem only. Clearing the shared one also erased whatever the live
          // screen had reported, which is how a refusal from the stream could be erased by an
          // unrelated success arriving a moment later.
          setFrameProblem(null);
        }
      } finally {
        if (generation.current === mine && shouldContinue()) {
          timer = setTimeout(tick, intervalMs);
        }
      }
    };

    void tick();
    return () => {
      generation.current++;
      clearTimeout(timer);
    };
  }, [
    computerId,
    active,
    followingRun,
    intervalMs,
    secretPending,
    settled,
    visualVisible,
  ]);

  /** Poll control state independently from screenshot polling so help/secret prompts surface. */
  useEffect(() => {
    if (settled) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      const state = await readControl(computerId);
      if (!live) return;
      if (state) setControl(state);
      timer = setTimeout(tick, 1000);
    };
    void tick();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [computerId, settled]);

  // Input forwarding lives in LiveScreen on the socket.
  // Escape is bound to the window so it works regardless of overlay focus.
  useEffect(() => {
    if (!expanded) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setExpanded(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expanded]);

  // Always render the card frame; help/secret controls live below the conditional picture.
  /*
   * A finished turn is never "blank": it opened a page, and that is what it shows or names. Only a
   * live browser can be sitting on about:blank.
   */
  const blankBrowser = !settled && shot ? isBlankBrowser(shot) : false;

  /*
   * Sized from the ratio, never from the payload, so the frame is identical while a screen is
   * loading, once it arrives, and while the browser has nothing open. A blank browser used to
   * collapse to a strip of text; that made the panel change shape the moment a page opened, and a
   * surface whose whole job is showing a screen kept surprising the layout around it.
   */
  const frameStyle = { aspectRatio, minWidth, minHeight };
  /**
   * What this tile draws: the kept frame for a turn that is over, the live one while it runs.
   *
   * A finished turn never draws `shot`. It may hold one, caught in the render between mounting and
   * its result arriving, and that frame is of whatever the Bot has open now rather than of this turn.
   */
  const drawn = settled
    ? keptFrame
    : shot
      ? { base64: shot.base64, url: shot.url ?? "" }
      : null;
  /** Whether there is a page to draw. A blank browser and an unreadable screen are both "no". */
  const showScreen = drawn !== null && !blankBrowser;
  /*
   * DRIVING ALWAYS MEANS LIVE, AND THAT IS THE WHOLE OF "take control does nothing".
   *
   * `settled` means this turn is a RECORD — it says what the desktop looked like when the Bot was
   * doing that piece of work. Control is not about the record. The wheel belongs to the person and the
   * desktop outlives every conversation, so "I have control" is a claim about the machine in front of
   * them NOW.
   *
   * This used to be `!settled && (showScreen || driving)`, and that expression made the two halves of
   * the feature unreachable at once on any finished turn: no live screen, and — further down — no Take
   * control button either. So a person who did find the button, took the wheel, and watched nothing
   * happen was not imagining it. `driving` was true, the server recorded them as the holder, the Bot
   * began refusing its own actions with "a person has control", and the picture stayed a frozen
   * JPEG of a page from an hour earlier. Every signal said it worked and no pixel moved.
   *
   * Driving now wins, always. A record is what you look at while the Bot works; the moment you take
   * the wheel you are looking at the live desktop, which is the only thing you can actually type at.
   */
  /*
   * DRIVING ALWAYS MEANS LIVE, AND A WATCHING PANEL MEANS LIVE WHILE THE BOT WORKS.
   *
   * `settled` means this turn is a RECORD — it says what the desktop looked like when the Bot was
   * doing that piece of work. Control is not about the record. The wheel belongs to the person and the
   * desktop outlives every conversation, so "I have control" is a claim about the machine in front of
   * them NOW.
   *
   * This used to be `!settled && (showScreen || driving)`, and that expression made the two halves of
   * the feature unreachable at once on any finished turn: no live screen, and — further down — no Take
   * control button either. So a person who did find the button, took the wheel, and watched nothing
   * happen was not imagining it. `driving` was true, the server recorded them as the holder, the Bot
   * began refusing its own actions with "a person has control", and the picture stayed a frozen
   * JPEG of a page from an hour earlier. Every signal said it worked and no pixel moved.
   *
   * Driving now wins, always. A record is what you look at while the Bot works; the moment you take
   * the wheel you are looking at the live desktop, which is the only thing you can actually type at.
   *
   * AND `followingRun` WINS OVER `showScreen`, which is the other half of "the small screen is stuck".
   * A watching panel has no `toolCallId`, so it is never `settled`, and `showScreen` then decided
   * everything on whether a still frame happened to have arrived — so the panel drew no screen until one
   * did and then drew that same one indefinitely. `followingRun` is an actual answer to "is the Bot
   * working right now", and when the answer is yes the panel is attached to the desktop over the live
   * stream rather than sampling a JPEG of it once a second.
   *
   * The still is kept for everything else: a panel nobody is running anything in, and the settled record
   * a finished turn leaves behind. Those want a picture, not a stream, and neither wants to keep a
   * connection open to a machine that is doing nothing.
   */
  /*
   * THE LIVE DESKTOP, OR A PICTURE OF IT.
   *
   * `driving` always wins, and has to: taking the wheel is a claim about the machine in front of this
   * person NOW, so the surface they can type at is the only honest thing to show, whatever else is true.
   *
   * `followingRun` is the watch panel's answer to "is the Bot working right now", and it is what moved
   * that panel off a single frozen frame. It is consulted BEFORE `!settled && showScreen` rather than
   * added to it, and the reason is the difference between the two kinds of tile. A transcript tile is
   * never `settled` exactly while its turn is live, so for that tile `!settled` already means "live" and
   * adding a second signal would be redundant. The panel is never `settled` at all — it has no turn, no
   * `toolCallId`, and no end — so there `!settled` says nothing whatsoever, and letting it decide meant
   * the panel showed a live stream whenever a still happened to exist and a frozen JPEG whenever one did
   * not. Same expression, opposite behaviour, decided by which kind of thing is asking.
   *
   * So a tile that is following a run trusts `followingRun` alone, and only falls back to the old
   * inference when nothing told it either way. `settled` still wins underneath both: a finished turn is a
   * record and keeps its kept frame, which is what makes it worth having.
   */
  /*
   * The live screen is the DEFAULTSURFACE rather than something that waits for a run.
   *
   * Before: the panel silently worked live only while the Bot was driving in-view (`driving`) or
   * while the page could tell a run was in flight (`followingRun`). The gap between those and the
   * wall time a Bot spends inside computer tools — when the wire run briefly ENDS before the browser
   * starts it again — is most of that wall time, so the panel spent it there showing
   * a stale settled still and a problem overlay, even though the machine was up.
   *
   * Now: any surface that is not settled history shows the live noVNC stream. Settled tiles in the
   * transcript keep their kept frame. If there is no desktop yet, the stream route is the thing that
   * starts one, which is the one behaviour the person pressing into that screen expected anyway.
   */
  const showLiveScreen = driving ? true : (followingRun ?? !settled);
  /*
   * A LIVE FAILURE IS ABOUT THE LIVE SCREEN, AND ONLY THE LIVE SCREEN MAY CLEAR IT.
   *
   * `problem` prefers `liveProblem`, so a reason left over from a stream that failed while the Bot was
   * driving outlived the stream: the panel went on saying "This computer is not running" underneath a
   * still frame that was arriving perfectly well, because the surface that failed was no longer the
   * surface being drawn. Clearing it when the live screen stops being drawn is the honest rule — the
   * statement "the live stream failed" has no subject once nothing is showing a live stream.
   *
   * Deliberately NOT cleared by a successful still, which is the mirror of the bug this split was
   * written to fix: a healthy screenshot must not be able to erase a refusal from the surface the person
   * actually acted on.
   */
  useEffect(() => {
    if (!showLiveScreen) setLiveProblem(null);
  }, [showLiveScreen]);
  /*
   * Whether the wheel in somebody's hands is the wheel THIS tile is showing.
   *
   * No longer gated on `!settled`. It used to be, to stop a frozen tile claiming "You have control"
   * over a page from an hour ago — a real concern, and it was answered by hiding the screen instead of
   * by showing the right one. Now that driving renders the live desktop, the thing being described and
   * the thing being shown are the same machine, so the claim is true and there is nothing to suppress.
   */
  const wheelHere = driving;

  const polledScreen = showScreen ? (
    <img
      src={`data:image/png;base64,${drawn.base64}`}
      alt="What the assistant is looking at"
      // Keep unexpected screenshot dimensions inside the reserved frame.
      className="absolute inset-0 h-full w-full object-contain opacity-100 transition-opacity duration-300 starting:opacity-0"
    />
  ) : null;

  /*
   * THE INLINE CARD CAN SHOW THE LIVE DESKTOP, AND UNTIL IT DID IT COULD NOT FOLLOW ANYTHING.
   *
   * `showLiveScreen` was consulted in exactly one place — the full-size dialog — so the inline card always
   * drew `polledScreen` and nothing else. Which is why the watch panel, which IS the inline card, sat on a
   * single sampled frame for as long as it was open: not because the poll was too slow, but because the
   * surface that could move was never mounted at that size. No interval fixes that.
   *
   * So the live surface is rendered here too, under the same condition, and the still is what remains for
   * everything else: a panel nobody is working in, and the settled record a finished turn leaves behind.
   *
   * NOT NESTED INSIDE THE `<img>` AND NOT INSTEAD OF THE CLICK TARGET. The button around both opens the
   * full-size view and has to keep doing so — a person watching a Bot work should be able to click the
   * small picture to get a big one, which is the whole reason this card is a button.
   */
  const inlineLiveScreen = showLiveScreen ? (
    <div className="absolute inset-0">
      <LiveScreen
        computerId={computerId}
        driving={driving}
        session={warmedSession}
        onProblem={setLiveProblem}
      />
    </div>
  ) : null;

  return (
    <>
      <figure ref={previewRef} className="overflow-hidden rounded-2xl border">
        {/* Inline preview remains in transcript; click opens a readable full-size view. */}
        <button
          type="button"
          onClick={() => setExpanded(true)}
          /*
           * Opens whether or not there is a picture in it. It used to be disabled without one, and
           * the wheel is down there: a blank browser, a screen that had not arrived yet, or a
           * computer that could not be reached left a person with no way to take control at all —
           * the states where they most want it. With nothing to draw the full-size view shows these
           * same words, and the wheel below them.
           */
          className="relative block w-full cursor-pointer bg-muted"
          style={frameStyle}
          aria-label="Open the assistant's screen full size"
        >
          {/*
           * The live desktop, in the small frame, while the Bot is working — and never at the same time
           * as the still, which is the picture of a screen rather than the screen. Mutually exclusive on
           * purpose: drawing both would put a frozen JPEG over a moving desktop, and which one won would
           * depend on paint order rather than on anything a person could see.
           */}
          {showLiveScreen ? inlineLiveScreen : polledScreen}

          {/* Whose computer this is — and whose hands are on it — said on the picture itself. */}
          {name || wheelHere ? (
            <span className="absolute right-2 bottom-2 flex items-center gap-1.5">
              {name ? (
                <span className="flex items-center gap-1.5 rounded-full bg-black/60 py-1 pr-2.5 pl-1.5 font-medium text-white text-xs backdrop-blur-sm">
                  <ChannelAvatar participantIds={[computerId]} size={16} />
                  {name}
                </span>
              ) : null}
              {wheelHere ? (
                <span className="rounded-full bg-white px-2.5 py-1 font-medium text-black text-xs shadow-sm">
                  You have control
                </span>
              ) : null}
            </span>
          ) : null}

          {/*
            THE INLINE CARD DOES NOT SPEAK WHILE THE FULL-SIZE VIEW IS OPEN.
            
            Both are mounted at once: expanding draws the same surface over this one rather than
            replacing it, so this card kept rendering its own explanation underneath. The result on
            screen was the same sentence twice — a person whose desktop had stopped read "The screen
            is not available right now." and, immediately below it, "The screen is not available right
            now." Two identical lines with no difference between them, which reads as the card failing
            to understand rather than as a report of anything.

            The expanded view says it once, in the place the person is actually looking, and this card
            is behind the backdrop. The badges above are left alone: they label the computer and say
            who has their hands on it, they are not a report about the screen, and they are the one
            part of the card worth seeing through a translucent backdrop.
          */}
          {/*
           * "There is nothing here" has to account for the live screen too.
           *
           * It tested `showScreen`, which is about the STILL. With the live desktop now mounted in this
           * same frame, a card that was streaming the Bot's actual screen and simultaneously explaining
           * that it was "waiting for the assistant's screen" would be describing a surface it was already
           * showing — and the sentence is drawn on top of it.
           */}
          {showScreen || showLiveScreen || expanded ? null : (
            <NothingToSee
              blankBrowser={blankBrowser}
              page={knownPage}
              problem={problem}
              settled={settled}
            />
          )}
        </button>

        {/*
         * The Bot ASKING for the wheel, which is not the same thing as a person wanting it.
         *
         * The standing "who is driving" prose and the everyday Take control button live in the
         * full-size view, where there is a page big enough to drive. This row is the exception: a
         * request is an exceptional state with a reason attached, it is the one moment the screen is
         * waiting on a person rather than the other way round, and making them open the full-size
         * view to find out what was wanted would hide the reason behind a click. Taking the wheel
         * from here opens that view, because driving is what they are being asked to do.
         */}
        {!driving && !settled && control?.requested ? (
          <div className="flex items-start justify-between gap-3 border-t bg-amber-500/10 px-3 py-2 text-sm text-amber-900 dark:text-amber-200">
            <span>
              <strong className="font-medium">The assistant needs you.</strong>{" "}
              {control.reason}
            </span>
            {/* The primitive, not a hand-copied button: this copy had no focus ring
              and no `active` press, so it was the one control in this bar a keyboard
              user could not see they were on. `size="sm"` is the scale's own 28px. */}
            <Button
              className="shrink-0 text-xs"
              onClick={async () => {
                const state = await takeControl(computerId);
                if (state) setControl(state);
                setExpanded(true);
              }}
              size="sm"
              type="button"
            >
              Take control
            </Button>
          </div>
        ) : null}

        {/*
          Secret values go directly to the page path and are never included in the conversation.
          Audit records that a secret was supplied, not the value.
        */}
        {control?.secretWanted ? (
          <form
            className="border-t bg-muted/40 px-3 py-2 text-sm"
            onSubmit={async (event) => {
              event.preventDefault();
              if (!secret || sendingSecret) return;
              setSendingSecret(true);
              watchUntil.current = Date.now() + SECRET_CONFIRM_MS;
              const result = await supplySecret(computerId, secret);
              setSendingSecret(false);
              // Clear even on failure so plaintext is not left in the DOM.
              setSecret("");
              setSecretProblem(result.ok ? null : (result.error ?? null));
              const state = await readControl(computerId);
              if (state) setControl(state);
            }}
          >
            <label className="block" htmlFor="remii-secret">
              <span className="font-medium">The assistant needs </span>
              <span>{control.secretWanted}</span>
            </label>
            <div className="mt-1.5 flex gap-2">
              <input
                id="remii-secret"
                type="password"
                value={secret}
                onChange={(event) => setSecret(event.target.value)}
                autoComplete="off"
                autoCorrect="off"
                spellCheck={false}
                placeholder="Typed here, never shown to the assistant"
                className="min-w-0 flex-1 rounded-md border bg-background px-2 py-1 text-sm"
              />
              <button
                type="submit"
                disabled={!secret || sendingSecret}
                className="shrink-0 rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground disabled:opacity-50"
              >
                {sendingSecret ? "Sending…" : "Send to the page"}
              </button>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              This goes straight to the page. It is not shown in the
              conversation and the assistant never receives it.
            </p>
            {secretProblem ? (
              <p className="mt-1 text-xs text-destructive">{secretProblem}</p>
            ) : null}
          </form>
        ) : null}

        {/*
         * The inline card carries no persistent footer: taking the wheel, handing it back, and the
         * standing "who is driving" prose all live in the full-size view, where there is a page big
         * enough to drive. The two rows above appear only while the Bot is stuck — waiting on a
         * credential, or asking for the wheel — and go again when it is not.
         */}
      </figure>

      {/*
        Portal to body so fixed positioning is measured against the viewport, not containing panes.
      */}
      {expanded && typeof document !== "undefined"
        ? createPortal(
            <div
              role="dialog"
              aria-modal="true"
              aria-label="The assistant's screen"
              className="fixed inset-0 z-50 flex flex-col items-center justify-center p-4 sm:p-8"
            >
              {/*
                Backdrop closes only while read-only; during driving, Escape remains the exit. A
                turn that is over is always read-only, whoever is holding the live browser.
              */}
              <button
                type="button"
                onClick={() => !wheelHere && setExpanded(false)}
                aria-label="Close the assistant's screen"
                aria-hidden={wheelHere}
                tabIndex={wheelHere ? -1 : 0}
                className={`absolute inset-0 bg-black/80 ${wheelHere ? "cursor-default" : "cursor-zoom-out"}`}
              />
              {/* A card holding the screen, with who and the wheel centered beneath it. */}
              <div className="relative flex w-full max-w-[70vw] min-w-0 flex-col rounded-2xl bg-background p-4 shadow-2xl">
                {/*
                  Overlay uses the live socket; the inline card keeps low-cost polling. With no page
                  to draw it reserves the same frame and says the same thing the card does — the
                  wheel below is the reason this view opens at all in that state.
                */}
                <div
                  className={`relative max-h-[75vh] min-h-0 overflow-auto rounded-xl ${showLiveScreen ? "bg-black" : "bg-muted"}`}
                >
                  {/*
                    THE LIVE SCREEN FIRST, AND THAT IS THE POINT.
 *
 * While the Bot is working this is the live desktop, and so is the record underneath it — a person
 * looking at a finished turn sees the picture that turn produced. What changed is that taking the
 * wheel now switches this to the live desktop REGARDLESS of whether the turn is over.
 *
 * It used to check the record first, so on any finished turn a person who had taken control was shown
 * a frozen JPEG while the server recorded them as the holder and the Bot started refusing its own
 * actions. Everything said it had worked and nothing on screen moved. That ordering — record before
 * live — was what made "take control" appear broken.
 */}
                  {showLiveScreen ? (
                    <div className="relative w-full" style={{ aspectRatio }}>
                      <LiveScreen
                        computerId={computerId}
                        driving={driving}
                        session={warmedSession}
                        onProblem={setLiveProblem}
                      />
                      {liveProblem ? (
                        <div className="absolute inset-0 flex items-center justify-center bg-background/85 p-4 text-center text-sm text-muted-foreground">
                          <span>{liveProblem}</span>
                        </div>
                      ) : null}
                    </div>
                  ) : settled && drawn ? (
                    /*
                     * A record, opened larger. Not a window on the desktop.
                     *
                     * The one gesture for looking closer at what a turn did used to also be the one
                     * that replaced it with whatever the Bot had open at that moment. The kept frame
                     * exists to stop that; taking the wheel is now the separate, explicit way to get
                     * the live one.
                     */
                    <div className="relative w-full" style={{ aspectRatio }}>
                      <img
                        alt="What this turn had open"
                        className="absolute inset-0 h-full w-full object-contain"
                        src={`data:image/png;base64,${drawn.base64}`}
                      />
                    </div>
                  ) : (
                    <div className="relative w-full" style={{ aspectRatio }}>
                      <NothingToSee
                        blankBrowser={blankBrowser}
                        page={knownPage}
                        problem={problem}
                        settled={settled}
                      />
                    </div>
                  )}
                </div>
                {/*
                  EVERY PAST TURN CARRIES THE WHEEL NOW, and that is the second half of "take control
                  does nothing".

                  The wheel belongs to the person and the desktop outlives every conversation, so
                  "You have control" is a claim about the machine in front of them NOW — not about the
                  turn above this tile. Hiding the button on a settled turn meant the states where a
                  person most wants it, looking at a transcript with nothing running, were exactly the
                  states with no way to ask for it.

                  The old reason for hiding it was fair: a record should not offer control of whatever
                  the Bot has open at some later moment. It was answered by removing the wheel rather
                  than by showing the right thing. Now that taking it swaps the record for the LIVE
                  desktop above, what this row says and what is on screen are the same machine, which
                  is what the gating was trying to achieve in the first place.
                */}
                {
                  <div className="mt-4 flex items-center justify-center gap-4">
                    <span className="flex min-w-0 items-center gap-2 text-sm">
                      {/*
                        NOT THE NAME. It is already on the picture, as a badge over the bottom-right
                        of the screen itself, and this line sat four pixels below it saying the same
                        word — so somebody watching a Bot work saw its name twice, stacked, with an
                        avatar beside each. On a narrow tile the badge and this line also collided.

                        What is left here is the part that is NOT on the picture: who has their hands
                        on it. That is a statement about the present and the badge is a label on the
                        screen, and neither repeats the other.
                      */}
                      {driving ? (
                        <span className="truncate text-muted-foreground">
                          You have control — click and type on the page.
                          {control?.reason ? ` ${control.reason}` : null}
                        </span>
                      ) : control?.requested ? (
                        <span className="truncate text-muted-foreground">
                          <strong className="font-medium text-foreground">
                            The assistant needs you.
                          </strong>{" "}
                          {control.reason}
                        </span>
                      ) : null}
                    </span>
                    {driving ? (
                      <button
                        type="button"
                        onClick={() => void handBack()}
                        className="shrink-0 rounded-md bg-primary px-3 py-1.5 font-medium text-primary-foreground text-sm"
                      >
                        Hand back
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={async () => {
                          const state = await takeControl(computerId);
                          if (state) setControl(state);
                        }}
                        className="shrink-0 rounded-md border px-3 py-1.5 font-medium text-sm"
                      >
                        Take control
                      </button>
                    )}
                  </div>
                }
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
