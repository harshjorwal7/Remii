import { IconFolderFilled, IconLock } from "@tabler/icons-react";
import { AnimatePresence, motion } from "motion/react";
import { ComputerPlaceholder } from "@/components/computer/placeholder";
import { EASE_OUT } from "@/lib/motion";
import { cn } from "@/lib/utils";
import type { StoryBeat } from "./story-beats";

/**
 * A desktop mid-task, drawn rather than screenshotted, frozen on one beat of its story.
 *
 * PURE. It takes a beat and draws it; it owns no clock, no state and no reduced-motion decision, and it
 * does not know a story exists. `story-beats.ts` holds the sequence, `demo-screen.tsx` holds the timer,
 * and this file is the drawing.
 *
 * That split is not tidiness. `motion/react` binds its reduced-motion query when the module is evaluated
 * and bun runs every test file in one process, so a component that decided its own starting beat from
 * `useReducedMotion` could not be tested except in isolation — its test passed alone and failed in the
 * suite for reasons that had nothing to do with the code. Made pure, every beat on this screen is
 * reachable by handing it one, and the property worth caring about — that the story FINISHES — is a
 * plain assertion about a plain array rather than a race against twelve seconds of timers.
 *
 * Kept from the loop this replaced, because all three of these were right: it needs no asset, it follows
 * the theme through tokens, and it can never show a stale product screenshot. Kept decorative too — hidden
 * from the tree and inert to the pointer — because the cursor in it looks like something you could grab,
 * and a person who reaches for a picture and gets a dead cursor learns that this product's surfaces are
 * decoration.
 */

/** Where the cursor is on each beat, as percentages, so the story fits whatever size it is drawn at. */
const CURSOR_AT: Record<StoryBeat, { left: string; top: string }> = {
  rest: { left: "55%", top: "20%" },
  task: { left: "34%", top: "12%" },
  reading: { left: "46%", top: "44%" },
  stopped: { left: "50%", top: "58%" },
  "handed-back": { left: "78%", top: "86%" },
};

export function StoryDesktop({
  beat,
  className,
}: {
  /** Which beat to draw. The only thing this component is told. */
  beat: StoryBeat;
  className?: string;
}) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute inset-0 select-none",
        className,
      )}
    >
      <ComputerPlaceholder className="absolute inset-0 h-full w-full" />
      <BrowserWindow
        beat={beat}
        className="absolute top-[9%] left-[7%] w-[58%]"
      />
      <FinderWindow className="absolute right-[6%] bottom-[8%] w-[48%]" />
      <Cursor beat={beat} />
      <AnimatePresence>
        {beat === "stopped" ? <SignInWall key="wall" /> : null}
        {beat === "handed-back" ? <TheAnswer key="answer" /> : null}
      </AnimatePresence>
    </div>
  );
}

/**
 * The agent's pointer, moving because something is happening to it.
 *
 * `left` and `top` are `motion` values rather than a re-render so the pointer travels rather than
 * teleporting. It moves because the whole argument of this drawing is that the cursor has a reason to be
 * where it is, and a cursor that jumps between positions throws that away in the first second.
 *
 * The curve is the app's own entrance curve rather than one picked here, so the pointer reads as the same
 * hand that moves every other surface in this product. `static` on the transitions that do not move:
 * `AnimatePresence` re-runs an exit when the wall leaves, and an eased exit on something that is merely
 * being removed reads as a flicker.
 */
function Cursor({ beat }: { beat: StoryBeat }) {
  const at = CURSOR_AT[beat];

  return (
    <motion.div
      animate={{ left: at.left, top: at.top }}
      className="absolute"
      initial={false}
      transition={{ duration: 0.9, ease: EASE_OUT }}
    >
      {/* Tabler's pointer-2, inlined: the installed icon package predates it. */}
      <svg
        aria-hidden="true"
        className="size-5 text-foreground drop-shadow-sm"
        fill="none"
        focusable="false"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2"
        viewBox="0 0 24 24"
        xmlns="http://www.w3.org/2000/svg"
      >
        <path
          className="fill-background"
          d="M14.185 13.14l5.644 -2.202c1.625 -.634 1.538 -2.962 -.13 -3.473l-14.319 -4.382c-1.41 -.431 -2.73 .888 -2.298 2.298l4.382 14.318c.51 1.668 2.84 1.755 3.473 .13l2.202 -5.644a1.84 1.84 0 0 1 1.045 -1.045"
        />
      </svg>
    </motion.div>
  );
}

/** A text line that is deliberately not text. */
function Line({ className }: { className?: string }) {
  return (
    <div
      className={cn("h-1.5 rounded-full bg-muted-foreground/20", className)}
    />
  );
}

function WindowFrame({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "overflow-hidden rounded-lg border border-border bg-card shadow-black/5 shadow-lg",
        className,
      )}
    >
      {children}
    </div>
  );
}

/** Traffic lights, monochrome on purpose: the theme's grays, not macOS's colors. */
function TrafficLights() {
  return (
    <div className="flex items-center gap-1.5">
      <span className="size-2 rounded-full bg-muted-foreground/25" />
      <span className="size-2 rounded-full bg-muted-foreground/25" />
      <span className="size-2 rounded-full bg-muted-foreground/25" />
    </div>
  );
}

/**
 * The browser, the only window in the story that changes.
 *
 * Two changes and no others: the address bar fills on the second beat, and the page arrives on the third.
 * That is the smallest amount of change that can express "somebody opened this and read it", and every
 * element added past that is one more thing for the eye to take instead of the stop on beat four.
 */
function BrowserWindow({
  beat,
  className,
}: {
  beat: StoryBeat;
  className?: string;
}) {
  const addressed = beat !== "rest";
  const loaded = beat !== "rest" && beat !== "task";

  return (
    <WindowFrame className={className}>
      <div className="flex items-center border-border border-b px-2.5 py-1.5">
        <TrafficLights />
        {/* The address pill; the empty span mirrors the lights so it centers truly. */}
        <div className="mx-auto flex h-4.5 w-2/5 items-center justify-center gap-1 rounded-full bg-muted px-2">
          <IconLock className="size-2.5 text-muted-foreground/60" />
          {/*
           * A REAL ADDRESS, IN A REAL FONT, at this size.
           *
           * The loop drew a skeleton bar here, which is honest about being a placeholder and completely
           * forgettable — an address bar with no address in it is the clearest possible statement that
           * nothing is happening on this screen. So the one piece of real text on this drawing goes here,
           * where it does the most work, at the same greys as everything around it.
           */}
          {addressed ? (
            <span className="truncate font-mono text-[0.55rem] leading-none text-muted-foreground">
              example.com
            </span>
          ) : (
            <Line className="h-1 w-14 bg-muted-foreground/25" />
          )}
        </div>
        <span className="w-11" />
      </div>

      <div className="space-y-2.5 p-3">
        <div className="flex items-center gap-2">
          <div className="size-4 rounded bg-muted" />
          <Line className="w-10" />
          <Line className="w-8" />
          <div className="ml-auto h-4 w-12 rounded-md bg-primary/15" />
        </div>

        <div className="space-y-1.5 pt-1">
          <Line className="h-2 w-2/3 bg-muted-foreground/30" />
          <Line className="w-1/2" />
        </div>

        {/*
         * The page, arriving.
         *
         * Animated by height rather than opacity, because a page that fades in reads as a cross-fade and a
         * page that GROWS reads as loading, which is the thing that actually happened. `initial={false}`
         * so a beat that is already loaded draws open rather than animating in over the beat that is
         * supposed to be showing it.
         */}
        <AnimatePresence initial={false}>
          {loaded ? (
            <motion.div
              animate={{ height: "auto", opacity: 1 }}
              className="grid grid-cols-3 gap-2 overflow-hidden pt-1"
              exit={{ height: 0, opacity: 0 }}
              initial={{ height: 0, opacity: 0 }}
              key="page"
              transition={{ duration: 0.45, ease: EASE_OUT }}
            >
              {["a", "b", "c"].map((card) => (
                <div
                  className="rounded-md border border-border bg-background p-1.5"
                  key={card}
                >
                  <div className="h-9 rounded-sm bg-muted" />
                  <Line className="mt-1.5 h-1 w-3/4" />
                  <Line className="mt-1 h-1 w-1/2" />
                </div>
              ))}
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>
    </WindowFrame>
  );
}

/**
 * The wall, on beat four.
 *
 * Drawn OVER the page rather than in place of it, which is what a modal actually does and is why the
 * thing underneath still matters. Springed rather than eased, because a panel that eases in gently is a
 * panel that is loading, and one that arrives with a little overshoot is a panel that has interrupted
 * something — which is the entire point of this beat.
 */
function SignInWall() {
  return (
    <motion.div
      animate={{ opacity: 1, scale: 1 }}
      className="absolute top-[9%] left-[7%] w-[58%]"
      exit={{ opacity: 0, scale: 0.98 }}
      initial={{ opacity: 0, scale: 0.97 }}
      transition={{ type: "spring", bounce: 0.18, duration: 0.5 }}
    >
      <div className="rounded-lg border border-border bg-card p-3 shadow-lg shadow-black/10">
        <div className="flex items-center gap-1.5">
          <IconLock className="size-3 shrink-0 text-muted-foreground" />
          <span className="text-[0.6rem] font-medium tracking-tight text-foreground">
            Sign in to continue
          </span>
        </div>
        {/* Two fields and no third. A form with a submit button would be asking the person to type. */}
        <div className="mt-2 space-y-1.5">
          <div className="h-4 w-full rounded border border-border bg-background" />
          <div className="h-4 w-full rounded border border-border bg-background" />
        </div>
        <div className="mt-2 h-4 w-1/2 rounded-md bg-primary/15" />
      </div>
    </motion.div>
  );
}

/**
 * The answer, on the last beat.
 *
 * The only piece of prose in the drawing, and it is the demo task's own subject rather than a sentence
 * written for a picture — so what a person reads at the end of the drawn story is what they would have
 * read if the computer had been there. That sameness is deliberate: the two paths differ in whether a
 * machine did it, not in what it did.
 */
function TheAnswer() {
  return (
    <motion.div
      animate={{ opacity: 1, y: 0 }}
      className="absolute inset-x-0 bottom-0 flex justify-center p-3"
      exit={{ opacity: 0 }}
      initial={{ opacity: 0, y: 8 }}
      transition={{ duration: 0.4, ease: EASE_OUT }}
    >
      <p className="max-w-[80%] rounded-lg border border-border bg-card px-3 py-2 text-center text-[0.6rem] leading-snug text-muted-foreground shadow-lg shadow-black/5">
        This domain is for use in documentation. You may use this domain in
        literature without prior coordination or asking for permission.
      </p>
    </motion.div>
  );
}

/** A document glyph drawn in CSS: a page with a folded corner and two lines of nothing. */
function FileGlyph() {
  return (
    <div className="relative h-8 w-6.5 rounded-[3px] border border-border bg-background">
      <div className="absolute top-0 right-0 size-2 rounded-bl-[3px] border-border border-b border-l bg-muted" />
      <div className="absolute inset-x-1 bottom-1.5 space-y-1">
        <Line className="h-0.75 w-full" />
        <Line className="h-0.75 w-2/3" />
      </div>
    </div>
  );
}

/**
 * The Finder window, which never changes and never moves.
 *
 * Here for the same reason the loop's second window was: a desktop with one window is a diagram of a
 * desktop, and the second one is what makes the first read as a computer somebody is working on rather
 * than a rectangle. It is also the only element in the frame doing nothing at all, which is deliberate —
 * there is a beat for everything that matters and this is not one of them.
 */
function FinderWindow({ className }: { className?: string }) {
  const items: Array<{ key: string; folder: boolean }> = [
    { key: "reports", folder: true },
    { key: "invoice", folder: false },
    { key: "assets", folder: true },
    { key: "notes", folder: false },
    { key: "draft", folder: false },
    { key: "archive", folder: true },
  ];

  return (
    <WindowFrame className={className}>
      <div className="flex items-center border-border border-b px-2.5 py-1.5">
        <TrafficLights />
        <Line className="mx-auto h-1 w-14 bg-muted-foreground/25" />
        <span className="w-11" />
      </div>

      <div className="flex">
        <div className="w-14 space-y-1.5 border-border border-r bg-muted/40 p-2">
          {["one", "two", "three", "four"].map((row) => (
            <div className="flex items-center gap-1" key={row}>
              <span className="size-1.5 rounded-[2px] bg-muted-foreground/25" />
              <Line className="h-0.75 w-7" />
            </div>
          ))}
        </div>

        <div className="grid flex-1 grid-cols-3 gap-x-1 gap-y-2 p-2.5">
          {items.map((item) => (
            <div className="flex flex-col items-center gap-1" key={item.key}>
              {item.folder ? (
                <IconFolderFilled className="size-8 text-muted-foreground/25" />
              ) : (
                <FileGlyph />
              )}
              <Line className="h-0.75 w-7" />
            </div>
          ))}
        </div>
      </div>
    </WindowFrame>
  );
}
