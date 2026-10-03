import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { AnimatePresence, MotionConfig, motion } from "motion/react";
import * as React from "react";
import useMeasure from "react-use-measure";
import AgentOrb from "@/components/agents/orb/agent-orb";
import { Composer } from "@/components/channels/composer";
import { DesktopIllustration } from "@/components/computer/desktop-illustration";
import { ComputerPlaceholder } from "@/components/computer/placeholder";
import { Button } from "@/components/ui/button";
import { type AgentProfile, agentListQueryOptions } from "@/lib/agents/queries";
import { currentUserQueryOptions, needsOnboarding } from "@/lib/auth/queries";
import { appConfig } from "@/lib/generated/application-config";
import { completeOnboardingMutationOptions } from "@/lib/onboarding/mutations";
import { MascotAvatar } from "@/mascot/mascot-avatar";
import { queryClient } from "@/query-client";
import type { MascotChoice } from "../../../../shared/mascot-ids";

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

function WelcomeStep() {
  return (
    <div className="w-full flex flex-col items-center justify-center">
      <h1 className="text-3xl font-semibold tracking-tight max-w-md text-center">
        Welcome to {appConfig.brand.productName}
      </h1>
      <div className="h-32" />
      <AgentOrb size="72px" />
      {/*
       * A POSTER OF A COMPOSER, AND `pointer-events-none` IS WHAT MAKES IT ONE. Nothing here is
       * meant to be typed in, clicked or dropped on: it is a picture of the thing the person is
       * about to get, shown while they read a sentence about it.
       *
       * THE DROP THAT PASSES STRAIGHT THROUGH IT IS SOMEBODY ELSE'S TO CATCH, WHICH IS WORTH
       * SAYING OUT LOUD. The composer guards its own form against a dropped file navigating the
       * whole app away (`refuseDragOver` in `composer.tsx`), and that guard cannot fire here: an
       * element with no pointer events is never the target of the drop, so the event goes past it
       * to the document as if this composer were not on the page. What catches it is
       * `useUnclaimedDropGuard` in `routes/__root.tsx`, which refuses every drop nobody claimed —
       * the reason that guard lives at the root rather than in the composer, and the reason this
       * wrapper does not need to change to be safe. Taking `pointer-events-none` off to "fix" the
       * drop would turn the poster back into a live composer with nowhere to upload to.
       */}
      <div className="mx-auto mt-10 w-full max-w-md origin-top pointer-events-none">
        <Composer
          compact
          className="scale-90"
          editorClassName="text-base"
          initialValue="Hand off tasks to your team of agents"
        />
      </div>
    </div>
  );
}

function ComputerUseStep() {
  return (
    <div className="w-full flex flex-col items-center justify-center">
      <h1 className="text-3xl font-semibold tracking-tight max-w-md text-center">
        Each agent has its own computer
      </h1>
      <div className="h-8" />
      <div className="relative aspect-5/3 w-full max-w-lg rounded-2xl overflow-hidden border border-border">
        <ComputerPlaceholder className="absolute inset-0 h-full w-full" />
        <DesktopIllustration />
      </div>
    </div>
  );
}

/** What a roster card needs — placeholders carry these three fields and nothing more. */
type RosterCard = Pick<AgentProfile, "id" | "name" | "avatarSeed"> & {
  /**
   * The chosen mascot. Absent for the invented placeholders below, which seed from their own ids.
   */
  mascot?: Partial<MascotChoice> | null;
};

/**
 * Stand-ins for a deployment that has fewer than three agents to show. Invented names on
 * purpose: they illustrate what a roster looks like without claiming any of these exist here.
 */
const AGENTS_PLACEHOLDER: RosterCard[] = [
  {
    id: "placeholder-research",
    name: "Research Analyst",
    avatarSeed: "research-analyst",
  },
  { id: "placeholder-data", name: "Data Analyst", avatarSeed: "data-analyst" },
  {
    id: "placeholder-support",
    name: "Support Agent",
    avatarSeed: "support-agent",
  },
];

function RosterStep() {
  const { data: agents } = useQuery(agentListQueryOptions());
  // Strict per-user SaaS sandbox: no shared/public roster. Show the user's
  // own coworkers (own + deployment templates), never another person's.
  const explore = agents?.filter((a) => a.mine || a.isSystemTemplate) ?? [];
  // Always three cards: real agents first, placeholders topping up a sparse deployment.
  // slice past the end is just [], so a roster of three or more takes no placeholders at all.
  const roster: Array<RosterCard & { example?: boolean }> = [
    ...explore.slice(0, 3),
    ...AGENTS_PLACEHOLDER.slice(explore.length).map((placeholder) => ({
      ...placeholder,
      example: true,
    })),
  ];

  return (
    <div className="w-full flex flex-col items-center justify-center">
      <h1 className="text-3xl font-semibold tracking-tight max-w-md text-center">
        Choose from a variety of agents or create your own
      </h1>
      <div className="h-8" />
      <div className="w-full max-w-lg overflow-hidden grid grid-cols-1 md:grid-cols-2 gap-4">
        {roster.map((a) => {
          return (
            <div
              key={a.id}
              // Dimmed and labelled, so an invented name never reads as a Bot this deployment has.
              className={`bg-card p-4 rounded-lg flex flex-row gap-4 items-center ${a.example ? "opacity-70" : ""}`}
            >
              {/*
               * Static on this screen, and not for economy. A person is being shown what a roster
               * looks like, and three live mascots blinking at them is a second thing to look at
               * while they are trying to read the names.
               */}
              <MascotAvatar
                name={a.name}
                seed={a.avatarSeed}
                choice={a.mascot}
                size={40}
                animated={false}
              />
              <div className="flex min-w-0 flex-col">
                <h3 className="line-clamp-1 text-base font-medium tracking-tight">
                  {a.name}
                </h3>
                {a.example ? (
                  <span className="text-xs text-muted-foreground">Example</span>
                ) : null}
              </div>
            </div>
          );
        })}
        <div className="bg-card p-4 rounded-lg flex flex-row gap-4 items-center">
          <div className="rounded-full size-[40px] border border-foreground/30 border-dashed" />
          <h3 className="line-clamp-1 text-base font-medium tracking-tight text-foreground/70">
            Your own agent
          </h3>
        </div>
      </div>
    </div>
  );
}

const STEPS: Array<() => React.ReactNode> = [
  () => <WelcomeStep />,
  () => <ComputerUseStep />,
  () => <RosterStep />,
];

/** A pane arrives from the side the journey is moving toward, and leaves out the other. */
const variants = {
  initial: (direction: number) => ({ x: `${110 * direction}%`, opacity: 0 }),
  active: { x: "0%", opacity: 1 },
  exit: (direction: number) => ({ x: `${-110 * direction}%`, opacity: 0 }),
};

function RouteComponent() {
  const navigate = useNavigate();
  const complete = useMutation(completeOnboardingMutationOptions(queryClient));

  // Browser state on purpose: the step is not persisted while the wizard is being designed.
  const [step, setStep] = React.useState(0);
  const [direction, setDirection] = React.useState(1);
  // The way out: set once the completion is saved, it fades the whole page and then navigates.
  const [leaving, setLeaving] = React.useState(false);
  const [ref, bounds] = useMeasure();

  const last = step === STEPS.length - 1;

  const go = (to: number) => {
    setDirection(to > step ? 1 : -1);
    setStep(to);
  };

  return (
    // Outside `_app` on purpose: no sidebar and no chrome until onboarding is done.
    // The fade runs only after the completion is saved, so a failed save never fades a page the
    // person still needs — and navigation waits for the fade, so the home screen never pops in
    // over a half-faded wizard.
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
              <AnimatePresence
                custom={direction}
                initial={false}
                mode="popLayout"
              >
                <motion.div
                  animate="active"
                  custom={direction}
                  exit="exit"
                  initial="initial"
                  key={step}
                  variants={variants}
                >
                  {STEPS[step]()}
                </motion.div>
              </AnimatePresence>

              {complete.error ? (
                <p className="mt-4 text-destructive text-sm" role="alert">
                  {complete.error.message}
                </p>
              ) : null}

              <motion.div
                className="mt-20 flex flex-col items-center justify-center max-w-xs gap-4 w-full mx-auto"
                layout
              >
                <Button
                  className="w-full"
                  disabled={complete.isPending}
                  onClick={() => {
                    if (last) {
                      complete.mutate(undefined, {
                        onSuccess: () => setLeaving(true),
                      });
                    } else {
                      go(step + 1);
                    }
                  }}
                  size="lg"
                >
                  {complete.isPending
                    ? "Saving…"
                    : last
                      ? "Get started"
                      : "Continue"}
                </Button>
                {step !== 0 && (
                  <Button
                    className="w-full"
                    onClick={() => go(step - 1)}
                    variant="secondary"
                    size="lg"
                  >
                    Back
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
