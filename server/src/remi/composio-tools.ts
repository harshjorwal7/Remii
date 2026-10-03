import { z } from "zod";
import type { PluginStore } from "../plugins/store";
import type { GrantedTool } from "../plugins/tools";
import { toolResultText } from "../plugins/tools";

/**
 * Composio on demand, ported from Remi.
 *
 * A Bot holding dozens of app tools cannot weigh them all at once, so Remi never offers the
 * whole catalogue up front: one search finds the actions for a use case, one batch call runs
 * several at once, and one waiter watches an OAuth connection the person is finishing in
 * their browser.
 *
 * Split by what each needs: search and batch are pure functions over the tools a run was
 * already offered, so they are built beside the loop with no extra queries; the waiter reads
 * connection state and is built where the plugin store lives. All answer with sentences,
 * never throws.
 */

/** Every tool name this module offers, for the remote-agent callback router. */
export const COMPOSIO_TOOL_NAMES = [
  "composio_search_tools",
  "multi_execute",
  "wait_for_connections",
  "composio_workbench",
  "composio_sandbox_bash",
] as const;

function tool(
  name: string,
  description: string,
  parameters: z.ZodType,
  execute: (
    args: Record<string, never>,
    signal?: AbortSignal,
  ) => Promise<string>,
  effect: "read" | "write" = "read",
): GrantedTool {
  return {
    name,
    description,
    parameters,
    ref: `bot/${name}`,
    effect,
    execute: async (args: unknown, signal?: AbortSignal) => {
      signal?.throwIfAborted();
      return execute((args ?? {}) as Record<string, never>);
    },
  };
}

/**
 * Search and batch, scoped to the tools this run was offered.
 *
 * Built in the loop builder over the final offered set, so narrowing and handoff additions
 * are searchable too — and so no second grants read pays for what the run already holds.
 * Batch executes within the set (never itself, never the ask-person exit).
 */
export function searchAndBatchToolsFor(tools: GrantedTool[]): GrantedTool[] {
  const rank = (useCase: string): GrantedTool[] => {
    const tokens = useCase
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length > 2);
    const scored = tools
      .filter((candidate) => candidate.name !== "multi_execute")
      .map((candidate) => {
        const haystack =
          `${candidate.name} ${candidate.description}`.toLowerCase();
        let score = 0;
        for (const token of tokens) {
          if (haystack.includes(token)) score += 1;
        }
        return { candidate, score };
      })
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score);
    return scored.slice(0, 15).map((entry) => entry.candidate);
  };

  return [
    tool(
      "composio_search_tools",
      "Find the connected-app actions for a use case, by name and description, out of what this Bot holds. Call once per use case, then call the actions it names — including several at once with multi_execute.",
      z.object({
        use_case: z
          .string()
          .describe(
            "What the actions are for, e.g. 'send an email with an attachment'.",
          ),
      }),
      async (args) => {
        const useCase = String(
          (args as { use_case?: unknown }).use_case ?? "",
        ).trim();
        if (!useCase) return "Say what the actions are for.";
        const found = rank(useCase);
        if (found.length === 0) {
          return "Nothing this Bot holds matches that use case. If the app itself is missing, call connect_app so the person connects it, then search again.";
        }
        return found
          .map(
            (candidate) =>
              `- ${candidate.name}: ${candidate.description.slice(0, 200)}`,
          )
          .join("\n");
      },
    ),

    tool(
      "multi_execute",
      "Run several granted tools in parallel in one step and collect every answer. Use this after composio_search_tools names the actions, instead of calling them one turn at a time.",
      z.object({
        calls: z
          .array(
            z.object({
              tool: z.string().describe("The tool name, exactly as listed."),
              args: z
                .record(z.string(), z.unknown())
                .optional()
                .describe("Its arguments object."),
            }),
          )
          .min(1)
          .max(10)
          .describe("Up to ten calls, run in parallel."),
      }),
      async (args, signal) => {
        const calls = (args as { calls?: unknown }).calls;
        if (!Array.isArray(calls) || calls.length === 0) {
          return "List the calls to run.";
        }
        const byName = new Map(
          tools.map((candidate) => [candidate.name, candidate]),
        );
        const jobs = calls.slice(0, 10).map((entry, index) => {
          const record = entry as { tool?: unknown; args?: unknown };
          const name = typeof record.tool === "string" ? record.tool : "";
          const target = byName.get(name);
          return { index, name, target, args: record.args };
        });
        const run = async (job: (typeof jobs)[number]) => {
          signal?.throwIfAborted();
          if (
            !job.target ||
            job.name === "multi_execute" ||
            job.name === "ask_person"
          ) {
            return `[${job.index + 1}] ${job.name || "unnamed"}: not available to this run.`;
          }
          const callArgs =
            job.args && typeof job.args === "object" && !Array.isArray(job.args)
              ? job.args
              : {};
          try {
            const result = await job.target.execute(callArgs, signal);
            signal?.throwIfAborted();
            /*
             * The text half, because this is a PARALLEL BATCH SUMMARY: several tool answers joined
             * into one line of prose for the model. An image cannot go into that, and it has nothing
             * to contribute here anyway — the model reads the batch summary to decide what to do
             * next, not to look at a screenshot of one of six parallel calls.
             */
            return `[${job.index + 1}] ${job.name}: ${toolResultText(result).slice(0, 2000)}`;
          } catch (error) {
            return `[${job.index + 1}] ${job.name}: Error: ${error instanceof Error ? error.message : String(error)}`;
          }
        };
        const results = new Array<string>(jobs.length);
        await Promise.all(
          jobs
            .filter((job) => job.target?.effect !== "write")
            .map(async (job) => {
              results[job.index] = await run(job);
            }),
        );
        for (const job of jobs.filter(
          (candidate) => candidate.target?.effect === "write",
        )) {
          results[job.index] = await run(job);
        }
        return results.join("\n\n");
      },
      "write",
    ),
  ];
}

/**
 * The connection waiter, built where the plugin store lives.
 *
 * Offered beside the run's other deployment tools: after `connect_app` hands the person a
 * link, the model waits on the connection itself instead of telling the person to come back
 * later. Polls, with a bounded wait, and answers either way.
 */
export function waitToolFor(options: {
  plugins: PluginStore;
  actorId: string;
}): GrantedTool {
  const { plugins, actorId } = options;
  return tool(
    "wait_for_connections",
    "Wait for the person to finish connecting an app in their browser after connect_app gave them the link, then report what connected. Polls connection state; give up promptly when nothing arrives.",
    z.object({
      app: z.string().describe("The app slug being connected, e.g. 'gmail'."),
      timeout_seconds: z
        .number()
        .min(5)
        .max(120)
        .optional()
        .describe("How long to wait. Defaults to 60 seconds."),
    }),
    async (args) => {
      const a = args as { app?: unknown; timeout_seconds?: number };
      const slug = String(a.app ?? "")
        .trim()
        .toLowerCase()
        .replace(/^composio-/, "");
      if (!slug) return "Say which app to wait for.";
      const timeoutMs =
        Math.min(Math.max(a.timeout_seconds ?? 60, 5), 120) * 1000;
      const started = Date.now();
      for (;;) {
        const brokered = await plugins
          .brokeredConnectionsFor(actorId)
          .catch(() => []);
        const match = brokered.find(
          (row) =>
            row.serverId.toLowerCase() === slug ||
            row.serverId.toLowerCase() === `composio-${slug}` ||
            row.serverId.toLowerCase().replace(/^composio-/, "") === slug,
        );
        if (match) {
          return `${slug} is connected. Continue with what the connection was needed for.`;
        }
        if (Date.now() - started >= timeoutMs) {
          return `${slug} is not connected yet. The person may still be on the consent page — ask them to finish connecting, then continue or wait again.`;
        }
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    },
  );
}
