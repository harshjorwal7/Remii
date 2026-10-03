import { useRenderTool } from "@copilotkit/react-core/v2";
import { useQueryClient } from "@tanstack/react-query";
import { useRef } from "react";
import { z } from "zod";
import { ToolLine } from "@/components/channels/tool-line";
import { agentKeys } from "@/lib/agents/queries";
import { channelKeys } from "@/lib/channels/queries";

/**
 * How Remii's workspace administration reads in the transcript.
 *
 * RENDER ONLY. `bot_summon`, `bot_add`, `bot_delete`, `bot_grant`, `bot_revoke`,
 * `update_settings`, `connection_list` and `connection_revoke` all run on the server, where
 * the access checks, grants and audit rows are. What registers here is a line per call, so a
 * Bot that summoned, empowered or removed a coworker says so while doing it — and, on
 * completion of a roster-changing call, the roster and sidebar refetch so a summoned Bot's
 * channel appears and a deleted one leaves without a reload.
 */

const parameters = z.object({
  bot: z.string().optional(),
  template: z.string().optional(),
  name: z.string().optional(),
  title: z.string().optional(),
  job: z.string().optional(),
  instructions: z.string().optional(),
  kind: z.string().optional(),
  ref: z.string().optional(),
  connection: z.string().optional(),
  execution_mode: z.string().optional(),
  standing_instructions: z.string().optional(),
  action_policy: z.string().optional(),
});

const ROSTER_CHANGING = new Set([
  "bot_summon",
  "bot_add",
  "bot_update",
  "bot_delete",
  "bot_grant",
  "bot_revoke",
]);

const LABELS: Record<string, (given: Record<string, string>) => string> = {
  bot_summon: (given) =>
    given.template ? `Summoned ${given.template}` : "Summoned a Bot",
  bot_add: (given) => (given.name ? `Added ${given.name}` : "Added a Bot"),
  bot_update: (given) => (given.bot ? `Updated ${given.bot}` : "Updated a Bot"),
  bot_delete: (given) => (given.bot ? `Removed ${given.bot}` : "Removed a Bot"),
  bot_read: (given) =>
    given.bot ? `Inspected ${given.bot}` : "Inspected a Bot",
  bot_list: () => "Listed coworkers",
  coworker_status: (given) =>
    given.bot && given.bot !== "all"
      ? `Checked ${given.bot}'s status`
      : "Checked coworkers' status",
  bot_grant: (given) =>
    given.bot ? `Empowered ${given.bot}` : "Changed a Bot's powers",
  bot_revoke: (given) =>
    given.bot ? `Limited ${given.bot}` : "Changed a Bot's powers",
  update_settings: () => "Updated settings",
  connection_list: () => "Listed connections",
  connection_revoke: (given) =>
    given.connection
      ? `Disconnected ${given.connection}`
      : "Disconnected an app",
};

function Detail({
  name,
  given,
}: {
  name: string;
  given: Record<string, string>;
}) {
  switch (name) {
    case "bot_summon":
      return given.name ? <p>As {given.name}</p> : null;
    case "bot_update":
      return given.title || given.job ? (
        <p className="text-muted-foreground">
          {[given.title, given.job].filter(Boolean).join(" — ")}
        </p>
      ) : null;
    case "bot_grant":
    case "bot_revoke":
      return given.kind || given.ref ? (
        <p className="text-muted-foreground">
          {[given.kind, given.ref].filter(Boolean).join(": ")}
        </p>
      ) : null;
    case "update_settings":
      return given.execution_mode ? (
        <p>
          Execution mode:{" "}
          {given.execution_mode === "ask-first" ? "ask first" : "act directly"}
        </p>
      ) : null;
    default:
      return null;
  }
}

function AdminLine({ name }: { name: string }) {
  const queryClient = useQueryClient();
  // Tool calls already refetched for, so a re-render never refetches twice. Invalidation
  // itself is idempotent, so StrictMode's double render is harmless either way.
  const settled = useRef(new Set<string>());

  useRenderTool({
    name,
    parameters,
    render: ({ parameters: given, result, status, toolCallId }) => {
      const strings: Record<string, string> = {};
      for (const [key, value] of Object.entries(given ?? {})) {
        if (typeof value === "string" && value) strings[key] = value;
      }
      const running = status !== "complete" && result === undefined;
      const text = typeof result === "string" ? result : null;

      /*
       * Refetch in the render body, once per call. A hook cannot live here — this is a render
       * callback, not a component — and an effect cannot key on a call either. The ref guard
       * makes the repeat renders of one completed call free, and a roster-changing call is
       * exactly the one whose sidebar row must arrive without a reload.
       */
      const key = toolCallId ?? `${name}:${JSON.stringify(strings)}`;
      if (
        status === "complete" &&
        ROSTER_CHANGING.has(name) &&
        !settled.current.has(key)
      ) {
        settled.current.add(key);
        void queryClient.invalidateQueries({ queryKey: agentKeys.all });
        void queryClient.invalidateQueries({ queryKey: channelKeys.list() });
      }

      return (
        <ToolLine
          label={LABELS[name]?.(strings) ?? name}
          detail={strings.job}
          running={running}
        >
          <div className="space-y-1 text-sm">
            <Detail name={name} given={strings} />
            {text ? (
              <p className="text-muted-foreground whitespace-pre-wrap">
                {text}
              </p>
            ) : null}
          </div>
        </ToolLine>
      );
    },
  });

  return null;
}

export function BotAdminTools() {
  return (
    <>
      <AdminLine name="bot_summon" />
      <AdminLine name="bot_add" />
      <AdminLine name="bot_update" />
      <AdminLine name="bot_delete" />
      <AdminLine name="bot_read" />
      <AdminLine name="bot_list" />
      <AdminLine name="coworker_status" />
      <AdminLine name="bot_grant" />
      <AdminLine name="bot_revoke" />
      <AdminLine name="update_settings" />
      <AdminLine name="connection_list" />
      <AdminLine name="connection_revoke" />
    </>
  );
}
