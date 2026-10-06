import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { AnimatePresence, MotionConfig, motion } from "motion/react";
import * as React from "react";
import useMeasure from "react-use-measure";
import { Button } from "@/components/ui/button";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { currentUserQueryOptions, needsOnboarding } from "@/lib/auth/queries";
import {
  type DeploymentCapabilities,
  deploymentCapabilitiesQueryOptions,
} from "@/lib/deployment/queries";
import { appConfig } from "@/lib/generated/application-config";
import { completeOnboardingMutationOptions } from "@/lib/onboarding/mutations";
import { MascotAvatar } from "@/mascot/mascot-avatar";
import { queryClient } from "@/query-client";
import { REMII_AGENT_ID } from "../../../../shared/remii";
import {
  computerHoldingAgent,
  COPY,
  demoAvailability,
  shouldRunDemo,
} from "./onboarding/demo";
import {
  useDemoActivity,
  useDemoChannel,
  type DemoRunReport,
} from "./onboarding/demo-run";
import { Artifact, DemoScreen, PHASE_FOR_BEAT } from "./onboarding/demo-screen";
import type { StoryBeat } from "./onboarding/story-beats";
import { useWarmedDesktop } from "./onboarding/use-warmed-desktop";

export const Route = createFileRoute("/_authed/onboarding")({
  beforeLoad: async ({ context }) => {
    const user = await context.queryClient.ensureQueryData(
      currentUserQueryOptions(),
    );
    // Somebody who has finished, or whose deployment tracks no onboarding, has no business here.
    if (!user || !needsOnboarding(user)) {
      throw redirect({ to: "/" });
    }
  },
  component: RouteComponent,
});

/**
 * How long the artifact's elapsed count runs before it stops counting.
 *
 * The demo's own budget is ninety seconds and this is slightly longer, so the sentence is never printed
 * with a number that the screen above is still waiting to beat. Past this the count stops rather than
 * continuing, because the alternative is a sentence that keeps changing in a corner of somebody's screen
 * while they are trying to decide what to do next.
 */
const COUNT_CEILING_SECONDS = 95;

/**
 * The first screen: one idea, and the reason to believe it.
 *
 * The old wizard opened with an `AgentOrb`, a heading that named the product, and a `pointer-events-none`
 * poster of the composer — a picture of the thing the person was about to get, with a substantial comment
 * about the drop guard that a pointer-events-less element had made somebody else's problem. All of that
 * is gone, and the reason is the one this file exists for.
 *
 * A poster of the product is the most average object in software. Every tool that has ever asked a person
 * to sign up has shown them a screenshot of itself doing the thing it does, and none of them are
 * remembered. What people describe afterwards is a moment: something that was not expected, that happened
 * to them rather than being performed at them. So this screen states the promise and then gets out of the
 * way, and the next screen delivers the moment or is not offered.
 *
 * No `AgentOrb` either. It is a gradient that rotates, it appears on the sign-in screen and would have
 * appeared here as well, and two spinning gradients in the four seconds before the product's one good
 * idea is a warm-up act. The mascot is the product's cast and it is on the next screen, doing the thing.
 */
function WelcomeStep() {
  return (
    <div className="flex w-full flex-col items-center gap-6">
      <MascotAvatar
        name={appConfig.brand.productName}
        seed={REMII_AGENT_ID}
        size={72}
      />
      <h1 className="max-w-md text-center text-3xl font-semibold tracking-tight text-balance">
        {COPY.welcome}
      </h1>
      <p className="max-w-md text-center text-sm/relaxed text-muted-foreground text-balance">
        {COPY.welcomeBody}
      </p>
    </div>
  );
}

/**
 * A pane arrives from the right and leaves to the left.
 *
 * No direction parameter any more, and that is the one simplification the two-screen wizard earned. The
 * carousel had a `Back`, so a pane could be entered from either side and the variants took a `custom`
 * number to say which. There is no way back now — the screen behind the demo is a claim the demo has
 * already answered, and going back to it would unmount a real run — so there is only one direction and a
 * parameter that could only ever be one is a thing to get wrong.
 */
const variants = {
  initial: { x: "110%", opacity: 0 },
  active: { x: "0%", opacity: 1 },
  exit: { x: "-110%", opacity: 0 },
};

/**
 * Two screens, in one direction.
 *
 * The old wizard had three, with a `Continue` on the first two and a `Get started` on the third, and a
 * `Back` on the last two. That is a carousel, and a carousel asks a person to walk through a product
 * before letting them touch it. This one has a welcome, a demonstration, and the app — and the
 * demonstration starts by itself, because a purple cow that waits to be asked to perform is not
 * remarkable, it is a menu.
 *
 * SO THERE IS NO `BACK`, and that is the load-bearing deletion. The screen behind the demo is a promise
 * about what is about to happen; a person who went back to it after seeing the thing would be looking at
 * a claim they had already had answered, which is the worst possible moment to be re-reading copy. More
 * practically, going back would unmount the run, and the run is real: `useDemoChannel` is guarded to
 * fire once per wizard, so a second visit would find a conversation it could not re-run and no way to
 * say so. One direction is both the better journey and the only honest one.
 *
 * THE STEP IS NOT PERSISTED, and that is now load-bearing in the other direction. `onboardingStep` is a
 * column and `POST /api/me/onboarding` writes it, but this wizard keeps its position in `useState` — so a
 * reload lands on the welcome with a conversation already running behind it, which the demo screen picks
 * up by asking the server what that thread is doing rather than by starting a second run. The browser
 * state is what makes that recoverable, so it stays.
 */
function RouteComponent() {
  const navigate = useNavigate();
  const complete = useMutation(completeOnboardingMutationOptions(queryClient));

  const [step, setStep] = React.useState(0);
  // The way out: set once the completion is saved, it fades the whole page and then navigates.
  const [leaving, setLeaving] = React.useState(false);
  const [ref, bounds] = useMeasure();

  /*
   * What the deployment can actually do, decided before the wizard renders a single screen.
   *
   * `capabilities` and the roster are both read here rather than inside the demo step because the
   * decision between a real computer and a drawing one is not the demo screen's to make — it decides
   * what to draw inside a frame, and this decides whether there is a frame with a machine behind it. A
   * deployment with no E2B key must never mount a run it cannot finish, and a deployment with one must
   * never be shown a drawing while its desktop is twenty seconds away.
   */
  const { data: capabilities } = useQuery(deploymentCapabilitiesQueryOptions());
  const { data: agents } = useQuery(agentListQueryOptions());
  const availability = demoAvailability(
    capabilities as DeploymentCapabilities | undefined,
    computerHoldingAgent(agents),
  );

  /*
   * THE WARM, AND WHY IT IS HERE AND NOT IN THE DEMO STEP.
   *
   * `openDesktopStream` STARTS a paused desktop and CREATES one that has never existed, and
   * `live-screen.tsx` puts that first request at twenty seconds or more. Fetching it when the demo screen
   * mounts puts those twenty seconds between the person's click and anything appearing at all, on the one
   * screen where they are forming an opinion. So it is opened here, while they are reading two sentences,
   * and handed down — by which time it is open, and the demo screen mounts on a machine that is already
   * running.
   *
   * Enabled on the WELCOME screen rather than on the demo screen even though the demo is what needs it,
   * because the welcome screen is where the waiting is free. Gated on the capability rather than on the
   * step, so a deployment with no computer never pays to find that out.
   */
  const warm = useWarmedDesktop(availability === "live");

  /*
   * The conversation, created when the demo screen exists and not before.
   *
   * Held here rather than in the step so that the run survives the step being re-rendered, and so that
   * the artifact and the handoff onto `/` can both reach it. It is a real conversation with a real thread
   * and a real run on it, and it is what the person is handed when they leave: their first conversation
   * is already finished by the time they arrive, which is the only onboarding reward that is worth
   * anything — a list of features they have already been shown is not.
   */
  /*
   * GATED ON THE CAPABILITY, and this is a change of substance rather than of style.
   *
   * The drawn path used to run anyway, because "there is no conversation yet" was the only condition the
   * hook had. So a deployment with no E2B key paid for a model turn and then got a coworker explaining at
   * length that it cannot see a screen — and worse, it was left with that conversation in its sidebar,
   * which is the first thing the new person would find on their home screen. A demo that costs a run must
   * be a demo that runs.
   */
  const demo = useDemoChannel(shouldRunDemo(step, availability));
  const channel = demo.channel;

  const activity = useDemoActivity(channel);

  /*
   * What the run reports, and what the screen draws.
   *
   * `phase` is written in exactly three places — the run, the drawn story, and nothing else — and it is
   * never written by a timeout on this screen. That is what makes the elapsed count honest: nothing here
   * decides that a run has finished, so the number cannot be printed for a run that has not.
   */
  const [report, setReport] = React.useState<DemoRunReport>({
    phase: "preparing",
    reply: null,
  });

  /*
   * The clock's anchor, set by the first thing the run reports and by nothing else.
   *
   * A ref-free `??` rather than an effect, because `onReport` fires from inside an async run and a
   * timestamp written a render later is a timestamp of the wrong moment. The first call is the only one
   * that counts; every later one is the same run reporting progress.
   */
  const [startedAt, setStartedAt] = React.useState<number | null>(null);

  const onReport = React.useCallback((next: DemoRunReport) => {
    setStartedAt((was) => was ?? Date.now());
    setReport(next);
  }, []);

  /*
   * The drawn path has no run, so its beats arrive here instead. A reply is never overwritten by a beat:
   * the drawn story has none to give, and a beat arriving late must not blank something real.
   */
  const onBeat = React.useCallback((beat: StoryBeat) => {
    setReport((was) =>
      was.reply ? was : { phase: PHASE_FOR_BEAT[beat], reply: null },
    );
  }, []);

  const [elapsed, setElapsed] = React.useState(0);
  React.useEffect(() => {
    if (startedAt === null) return;
    const tick = () =>
      setElapsed(
        Math.min(
          Math.round((Date.now() - startedAt) / 1000),
          COUNT_CEILING_SECONDS,
        ),
      );
    /* Ticked once immediately, so a run that settles inside its first second reads as zero rather than
     * sitting on the initial value until the first interval fires a second later. */
    tick();
    const timer = setInterval(tick, 1_000);
    return () => clearInterval(timer);
  }, [startedAt]);

  const phase = report.phase;

  return (
    // Outside `_app` on purpose: no sidebar and no chrome until onboarding is done.
    // The fade runs only after the completion is saved, so a failed save never fades a page the
    // person still needs — and navigation waits for the fade, so the home screen never pops in
    // over a half-faded wizard.
    //
    // `overflow-y-auto`, NOT `overflow-hidden`.
    //
    // `justify-center` on a column taller than its container pushes content off BOTH ends, and
    // `overflow-hidden` then clipped that content with no way to reach it — on a short window the
    // wizard's buttons were simply not on screen. `py-10` gives the centred state room to breathe
    // and `auto` lets a tall step scroll instead of being cut.
    <motion.div
      animate={{ opacity: leaving ? 0 : 1 }}
      className={`flex min-h-svh w-full flex-col items-center justify-center overflow-y-auto px-4 py-10 ${leaving ? "pointer-events-none" : ""}`}
      initial={false}
      onAnimationComplete={() => {
        if (leaving) {
          navigate({ to: "/" });
        }
      }}
      transition={{ duration: 0.5, ease: "easeInOut" }}
    >
      <div className="mx-auto w-full max-w-2xl">
        <MotionConfig transition={{ duration: 0.5, type: "spring", bounce: 0 }}>
          {/* The frame follows each pane's height, so the buttons glide instead of jumping. */}
          <motion.div
            animate={{ height: bounds.height > 0 ? bounds.height : "auto" }}
            className="overflow-hidden"
          >
            <div ref={ref}>
              <AnimatePresence initial={false} mode="popLayout">
                <motion.div
                  animate="active"
                  exit="exit"
                  initial="initial"
                  key={step}
                  variants={variants}
                >
                  {step === 0 ? (
                    <WelcomeStep />
                  ) : (
                    <DemoScreen
                      activity={activity}
                      availability={availability}
                      channel={channel}
                      onBeat={onBeat}
                      onReport={onReport}
                      phase={phase}
                      reply={report.reply}
                      seed={REMII_AGENT_ID}
                      session={warm.session}
                    />
                  )}
                </motion.div>
              </AnimatePresence>

              {/*
               * THE ARTIFACT, AND THE ONE PLACE THIS SCREEN MAKES A CLAIM ABOUT ITS OWN TIMING.
               *
               * It appears once a real run has SETTLED WITH A REPLY, and those two conditions are doing
               * all the work. A sentence saying a coworker did something in eleven seconds, printed over a
               * run that has not answered yet, is the exact kind of thing that makes a person stop
               * trusting a product's copy for the rest of their time in it; and a reply is the one thing
               * only the live path can produce, so this cannot say it on a deployment where nothing was
               * done by anything. No check on `availability` is needed — the reply is the proof, and a
               * check that could disagree with it is a check that will eventually be wrong.
               */}
              {step === 1 && phase === "settled" && report.reply ? (
                <Artifact elapsedSeconds={elapsed} />
              ) : null}

              {complete.error ? (
                <p className="mt-4 text-destructive text-sm" role="alert">
                  {complete.error.message}
                </p>
              ) : null}

              {/*
               * `mt-10`, not the `mt-20` this used to carry. That gap was sized for a three-screen wizard
               * whose third screen was short; with the roster step gone the demo screen is the tallest
               * thing here, and twenty margin-top units pushed the button a long way under a live screen
               * somebody may well be watching rather than past.
               */}
              <motion.div
                className="mt-10 flex w-full max-w-xs flex-col items-center justify-center gap-4"
                layout
              >
                {step === 0 ? (
                  <Button
                    className="w-full"
                    onClick={() => setStep(1)}
                    size="lg"
                  >
                    Show me
                  </Button>
                ) : (
                  /*
                   * NEVER DISABLED, ON ANY BEAT, AND ONLY `complete.isPending` EVER IS.
                   *
                   * This used to be the end of a carousel a person walked through, so making it wait for
                   * the last beat would have been defensible. It is now the exit from a real run on a real
                   * machine, and a button that refuses to let somebody leave a demonstration is a button
                   * that gets pressed three times and then abandoned — and worse, it teaches that this
                   * product decides when it has finished introducing itself. The run does not stop when
                   * they leave: the conversation is still there, still working, and it is where they land.
                   */
                  <Button
                    className="w-full"
                    disabled={complete.isPending}
                    onClick={() => {
                      complete.mutate(undefined, {
                        onSuccess: () => setLeaving(true),
                      });
                    }}
                    size="lg"
                  >
                    {complete.isPending ? "Saving…" : "Get started"}
                  </Button>
                )}
              </motion.div>
            </div>
          </motion.div>
        </MotionConfig>
      </div>
    </motion.div>
  );
}
