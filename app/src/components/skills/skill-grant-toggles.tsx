import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { setPluginGrantMutationOptions } from "@/lib/plugins/mutations";

/**
 * Per-Bot grant switches, drawn inline on a skill row.
 *
 * WITHOUT ONE OF THESE A SKILL DOES NOTHING, and that is the thing this component exists to make
 * visible. A skill reaches a Bot's `/` menu only through a grant: the menu is fed by
 * `GET /api/plugins/for/:agentId`, which returns what that Bot HOLDS, and a row in `plugin_grants` IS
 * the grant — absence is the refusal. So a skill can be listed, readable, and completely inert, and
 * the page it is listed on is the only place that can be fixed. Every row here therefore says which
 * Bots carry it, including when that is none of them.
 *
 * ONLY BOTS THIS PERSON OWNS. The server requires that the Bot be the asker's, so offering the others
 * would mean drawing switches that fail on press — an affordance that can only ever refuse is worse
 * than no affordance, and it teaches the page is lying.
 *
 * A SEPARATE COMPONENT from `skill-agents.tsx`'s version because that one lives inside the edit form's
 * footer, where it is the only thing being edited. This one is a summary row: it must not render a
 * heading, and it must stay quiet about Bot count so a long roster does not dominate a list of skills.
 */
export function SkillGrantToggles({
  slug,
  grantedTo,
}: {
  slug: string;
  grantedTo: string[];
}) {
  const queryClient = useQueryClient();
  const { data: agents } = useQuery(agentListQueryOptions());
  const mine = (agents ?? []).filter((agent) => agent.mine);
  const held = new Set(grantedTo);
  const grant = useMutation(setPluginGrantMutationOptions(queryClient));

  // `on` is the current state, so a click asks for its opposite.
  const toggle = (agentId: string, on: boolean) =>
    grant.mutate({ agentId, granted: !on, kind: "skill", ref: slug });

  if (mine.length === 0) {
    return (
      <p className="text-muted-foreground text-xs">
        You do not own an Agent yet, so this is not on any of them.
      </p>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-muted-foreground text-xs">On:</span>
      {mine.map((agent) => {
        const on = held.has(agent.id);
        return (
          <button
            aria-pressed={on}
            className={`rounded-md border px-2 py-0.5 text-xs transition-colors disabled:opacity-50 ${
              on
                ? "border-primary/40 bg-primary/10 text-foreground"
                : "border-border text-muted-foreground hover:text-foreground"
            }`}
            disabled={grant.isPending}
            key={agent.id}
            onClick={() => toggle(agent.id, on)}
            type="button"
          >
            {agent.name}
          </button>
        );
      })}
      {grant.error ? (
        <span className="text-destructive text-xs" role="alert">
          {grant.error.message}
        </span>
      ) : null}
    </div>
  );
}
