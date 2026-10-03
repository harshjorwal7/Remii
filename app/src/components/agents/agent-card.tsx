import type { AgentProfile } from "@/lib/agents/queries";
import { cn } from "@/lib/utils";
import { MascotAvatar } from "@/mascot/mascot-avatar";

/**
 * A coworker as a card, for the roster carousel and the agents grid.
 *
 * The layout is two bands rather than one, and that is the whole change. It used to be a single
 * `h-[180px]` field with a 250px avatar absolutely centred in it and the name and role laid over the
 * top behind a 40% background scrim. Three things were wrong with that and only one of them was the
 * avatar being too big:
 *
 * - The body is a circle filling 77% of its frame, so a 250px avatar put ~190px of near-black into a
 *   180px box. The mascot was not behind the text; it was most of the card, and the text sat on top of
 *   it in grey, which is where the contrast went.
 * - The scrim existed to fix that and instead flattened a saturated mascot into mud while leaving the
 *   text still sitting on it.
 * - Nothing about it varied. Every card was the same disc, so the row read as a list of identical
 *   blobs rather than as a list of coworkers.
 *
 * So: the mascot is art on its own band, sized to be looked at rather than to fill, and the text gets
 * a solid surface of its own. The card is the one place a person chooses a coworker *by*, so the
 * mascot has room to be the thing being looked at — but it is a shape in a frame, not a background.
 *
 * The height is unchanged so the carousel's geometry is untouched.
 */
export function AgentCard({
  agent,
  className,
}: {
  agent: AgentProfile;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "h-[180px] w-full overflow-hidden rounded-2xl border bg-card",
        "flex flex-col text-left group",
        className,
      )}
    >
      <div className="bg-muted flex min-h-0 flex-1 items-center justify-center">
        {/*
         * 104px is the largest that leaves the text band its room in 180px. Anything bigger and the
         * card art starts winning against the name, which is the wrong way round for the one surface
         * where somebody is scanning for the name first.
         */}
        <MascotAvatar
          name={agent.name}
          seed={agent.id}
          choice={agent.mascot}
          size={104}
        />
      </div>
      <div className="flex flex-col gap-1 border-t p-3">
        <span className="line-clamp-1 text-sm font-medium">{agent.name}</span>
        <span className="line-clamp-2 text-xs text-muted-foreground">
          {agent.roleDescription}
        </span>
      </div>
    </div>
  );
}
