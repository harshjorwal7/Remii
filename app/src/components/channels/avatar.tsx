import { memo } from "react";
import type { AIState } from "@/components/agents/orb/ai-core";
import { cn } from "@/lib/utils";
import { MascotAvatar } from "@/mascot/mascot-avatar";
import type { MascotChoice } from "../../../../shared/mascot-ids";

/**
 * Memoized roster avatar. Row updates usually change preview/timestamp only, and
 * `use-channel-events` preserves participant id arrays for unchanged rows.
 *
 * `mascots` is the chosen mascot per participant, which a channel carries because a channel announces
 * its agents and nothing else. It is optional because several callers pass a bare id — a computer, or
 * an agent the roster has in hand without its profile — and those mascots simply seed from the id,
 * which is the same face the profile screen would show for an undressed coworker.
 *
 * `state` is the participant's work state, and it is the difference between a mascot and a coworker.
 * Without it every avatar on every surface sits in its resting loop forever, because `MascotAvatar`
 * defaults to `idle` and a roster that never leaves idle cannot say anything about the work. With it
 * the same six states `ai-core.tsx` defines are drawn as a character: the rings flare while a Bot
 * thinks, and a failed run puts a pip on the shoulder.
 *
 * It is per participant rather than per channel because a channel row can hold more than one avatar,
 * and only one of them can be the one working. Absent means idle, so callers with no state to report
 * pass nothing and get the resting mascot rather than a wrong face.
 *
 * `typing` overlays a working indicator at the bottom-right — three bouncing dots, so a channel
 * whose agent is mid-turn reads as busy from the roster without moving the row's layout.
 */
export const ChannelAvatar = memo(function ChannelAvatar({
  participantIds,
  mascots,
  size = 32,
  typing = false,
  states,
}: {
  participantIds: string[];
  /** Chosen mascots by participant id. Absent participants seed from their id. */
  mascots?: Record<string, Partial<MascotChoice>>;
  size?: number;
  typing?: boolean;
  /**
   * Each participant's work state, by id. Read per participant rather than taken as one value,
   * because a multi-participant row has several avatars and only one of them can be working.
   */
  states?: Record<string, AIState>;
}) {
  const channelSize = participantIds?.length;

  const avatar =
    channelSize === 1 ? (
      <MascotAvatar
        name={participantIds[0] ?? ""}
        seed={participantIds[0] ?? ""}
        choice={mascots?.[participantIds[0] ?? ""]}
        size={size}
        state={states?.[participantIds[0] ?? ""]}
      />
    ) : (
      <div className="flex flex-row items-center size-full">
        {participantIds.slice(0, 3).map((c, i, shown) => (
          <div
            className="shrink-0 border-2 border-sidebar rounded-full flex items-center justify-center"
            key={c}
            style={{
              height: size / (shown.length / 2),
              width: size / (shown.length / 2),
              transform: `translateX(${i * -75}%)`,
            }}
          >
            {/*
             * Scaled down to fit the stack rather than drawn full size and clipped: at 16px inside a
             * 24px slot the silhouette has to actually fit, and `overflow-hidden` on the SVG would
             * otherwise crop whichever shape happened to be chosen.
             */}
            <MascotAvatar
              name={c}
              seed={c}
              choice={mascots?.[c]}
              size={size / (shown.length / 2)}
              state={states?.[c]}
            />
          </div>
        ))}
      </div>
    );

  return (
    <div className="relative" style={{ height: size, width: size }}>
      {avatar}
      {typing ? <TypingBadge /> : null}
    </div>
  );
});

/**
 * Three bouncing dots in a small badge, ringed in the sidebar's own colour so it sits on the
 * avatar as a badge rather than floating over it. The staggered negative delays start each dot at
 * a different point in the same bounce, which is what makes the three read as one wave.
 */
function TypingBadge() {
  return (
    <div className="absolute -bottom-0.5 -right-0.5 flex items-center gap-0.5 rounded-full bg-sidebar p-0.5 ring-2 ring-sidebar">
      <span className="sr-only">Working…</span>
      <Dot className="[animation-delay:-0.3s]" />
      <Dot className="[animation-delay:-0.15s]" />
      <Dot />
    </div>
  );
}

function Dot({ className }: { className?: string }) {
  return (
    <span
      className={cn("size-1 rounded-full bg-primary animate-bounce", className)}
    />
  );
}
