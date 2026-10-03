import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { Database } from "../db/client";
import type { GrantedTool } from "../plugins/tools";
import { artifactStorageKey, type BlobStore } from "../storage/blob-store";
import type { createRemiStore } from "./store";

/**
 * Remi's tools as Remii deployment tools.
 *
 * Built per run with the run's Bot, person and thread bound in, the way `connect_app` and the
 * escalation tool are: the model is offered plain names (`memory_save`), and lookup by name also
 * serves the remote-agent callback path. Memory, artifacts, todos, schedules, chat history and
 * web search — the whole Remi loop minus the loop itself, which Remii's runtime already is.
 */

export type RemiToolsOptions = {
  database: Database;
  embeddingsApiKey?: string;
  embeddingsBaseUrl?: string;
  artifactsDir?: string;
  /** Where a saved file's bytes go. Absent means the legacy path under `artifactsDir`. */
  blobs?: BlobStore;
  /**
   * The model briefs and debriefs are distilled with. Absent, the brief and
   * debrief tools answer that they cannot run rather than spending a key the
   * deployment never chose: a delegation brief written by no model is a task
   * handed over with no context.
   */
  model?: { provider: "openai"; model: string };
  environment?: Record<string, string | undefined>;
  /** Resolved lazily per call: briefs and debriefs spend the deployment key. */
  getApiKey?: () => Promise<string | null>;
  /**
   * Live web search, in the Remi shape.
   *
   * Absent means the deployment has no search endpoint and the tools are not offered at all:
   * a model offered a search it cannot run spends attention on it and then apologises. Reads
   * `WEB_SEARCH_API` / `WEB_SEARCH_URL` at the call site, the way embeddings read theirs.
   */
  webSearchApiKey?: string;
  webSearchBaseUrl?: string;
  getThreadMessages?: (
    threadId: string,
  ) => Promise<
    Array<{ role?: string; content?: unknown; createdAt?: unknown }>
  >;
};

const DEFAULT_ARTIFACTS_DIR = join(
  import.meta.dir,
  "..",
  "..",
  ".data",
  "artifacts",
);

/** Every tool name this module offers, for the remote-agent callback router. */
export const REMI_TOOL_NAMES = [
  "memory_save",
  "memory_search",
  "memory_list",
  "memory_update",
  "memory_delete",
  "handoff_brief",
  "handoff_debrief",
  "task_note",
  "task_notes",
  "artifact_create",
  "artifact_list",
  "artifact_read",
  "artifact_delete",
  "todo_add",
  "todo_list",
  "todo_update",
  "todo_delete",
  "schedule",
  "automations",
  "get_chat_history",
  "web_search",
  "web_open",
] as const;

/**
 * The tools in {@link REMI_TOOL_NAMES} that are for finding things out.
 *
 * Split out because a supervisor is given the rest and not these: memory, notes,
 * todos, schedules, artifacts and the brief and debrief either side of a handoff
 * are a supervisor's own bookkeeping, while searching the web and opening a
 * page are how it would do the research it was supposed to hand to somebody.
 */
export const REMI_RESEARCH_TOOL_NAMES = ["web_search", "web_open"] as const;

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object") {
          const text = (part as { text?: unknown }).text;
          return typeof text === "string" ? text : "";
        }
        return "";
      })
      .join("\n");
  }
  return "";
}

export function remiToolsFor(options: {
  store: ReturnType<typeof createRemiStore>;
  botId: string;
  actorId: string;
  threadId?: string;
  tools: RemiToolsOptions;
}): GrantedTool[] {
  const { store, botId, actorId, threadId } = options;
  const artifactsDir = options.tools.artifactsDir ?? DEFAULT_ARTIFACTS_DIR;
  const blobs = options.tools.blobs;

  const tool = (
    name: string,
    description: string,
    parameters: z.ZodType,
    execute: (args: Record<string, never>) => Promise<string>,
  ): GrantedTool => ({
    name,
    description,
    parameters,
    ref: `remi/${name}`,
    execute: async (args: unknown) =>
      execute((args ?? {}) as Record<string, never>),
  });

  return [
    tool(
      "memory_save",
      "Save a durable fact about the person, their preferences, or how their world works, so it is still known in later conversations. Prefer one fact per call.",
      z.object({
        content: z.string().describe("The fact, in one or two sentences."),
        scope: z
          .enum(["global", "chat", "persona"])
          .optional()
          .describe("Who it is true for. Defaults to this conversation's Bot."),
        tags: z.array(z.string()).optional(),
        category: z.string().optional(),
        importance: z.number().min(1).max(10).optional(),
      }),
      async (args) => {
        const content = String((args as { content?: unknown }).content ?? "");
        const scope = (args as { scope?: string }).scope;
        // Task scope without a task is a row no read can ever reach: task
        // queries filter by task id, so it would be stored and never recalled.
        // Refused with the reason rather than silently lost.
        if (scope === "task" && !threadId) {
          return "Task scope needs an open task, and this run has none: save it to your own scope instead.";
        }
        const result = await store.saveMemory({
          userId: actorId,
          botId,
          content,
          scope,
          // Task-scoped saves belong to this conversation's episode, so
          // parallel jobs never see each other's working notes.
          ...(scope === "task" && threadId ? { taskId: threadId } : {}),
          tags: (args as { tags?: string[] }).tags,
          category: (args as { category?: string }).category,
          importance: (args as { importance?: number }).importance,
          source: "explicit",
        });
        return result.saved
          ? "Saved."
          : "Not saved: nothing new, or nothing worth keeping.";
      },
    ),

    tool(
      "memory_search",
      "Recall what is known: people, preferences, past decisions, how things work here. Call it before answering from memory about the person. Task memories for THIS conversation's task are included automatically.",
      z.object({
        query: z.string().describe("What to recall."),
        limit: z.number().min(1).max(25).optional(),
      }),
      async (args) => {
        const result = await store.searchMemories({
          userId: actorId,
          botId,
          query: String((args as { query?: unknown }).query ?? ""),
          limit: (args as { limit?: number }).limit,
          ...(threadId ? { taskId: threadId } : {}),
        });
        if (!result.found) return "Nothing remembered on that.";
        return result.memories
          .map((memory) => `- ${memory.content}`)
          .join("\n");
      },
    ),

    tool(
      "memory_list",
      "List remembered facts with exact filters rather than semantic search.",
      z.object({
        scope: z.string().optional(),
        category: z.string().optional(),
        limit: z.number().min(1).max(50).optional(),
      }),
      async (args) => {
        const rows = await store.listMemories({
          userId: actorId,
          botId,
          scope: (args as { scope?: string }).scope,
          category: (args as { category?: string }).category,
          limit: (args as { limit?: number }).limit,
        });
        if (rows.length === 0) return "No remembered facts match.";
        return rows.map((row) => `- [${row.id}] ${row.content}`).join("\n");
      },
    ),

    tool(
      "memory_update",
      "Correct or extend a remembered fact by its id (see memory_list).",
      z.object({
        id: z.string(),
        content: z.string().optional(),
        importance: z.number().min(1).max(10).optional(),
      }),
      async (args) =>
        (await store.updateMemory(
          String((args as { id?: unknown }).id ?? ""),
          actorId,
          {
            content: (args as { content?: string }).content,
            importance: (args as { importance?: number }).importance,
          },
        ))
          ? "Updated."
          : "No such memory, or nothing to change.",
    ),

    tool(
      "memory_delete",
      "Forget a remembered fact by its id.",
      z.object({ id: z.string() }),
      async (args) =>
        (await store.deleteMemory(
          String((args as { id?: unknown }).id ?? ""),
          actorId,
        ))
          ? "Forgotten."
          : "No such memory.",
    ),

    tool(
      "handoff_brief",
      "Compile the brief before delegating to another Bot: this task's episode so far, relevant durable context, and the constraints to hand over. Call it, then paste the brief into delegate_bot — never hand over a bare task and make the other Bot rediscover everything.",
      z.object({
        targetBot: z.string().describe("The Bot being briefed (id or name)."),
        task: z.string().describe("What is being asked, in your own words."),
        constraints: z
          .array(z.string())
          .optional()
          .describe("Hard rules for this job (e.g. draft, never send)."),
      }),
      async (args) => {
        const model = options.tools.model;
        if (!model) {
          return "No model is configured for briefs: hand over the task text itself.";
        }
        const a = args as {
          targetBot?: unknown;
          task?: unknown;
          constraints?: unknown;
        };
        const { buildBrief } = await import("./handoff-brief");
        const brief = await buildBrief({
          store,
          userId: actorId,
          targetBotId: String(a.targetBot ?? ""),
          taskId: threadId ?? "",
          task: String(a.task ?? ""),
          constraints: Array.isArray(a.constraints)
            ? a.constraints.map(String)
            : undefined,
          model,
          environment: options.tools.environment,
        }).catch(() => null);
        if (!brief) {
          return "The brief could not be compiled: hand over the task text itself.";
        }
        return brief.brief;
      },
    ),

    tool(
      "handoff_debrief",
      "Close out a delegated task: distill what was learned into durable conclusions. Call it with the outcome when a handoff returns. Task trivia stays in the episode; only what is true beyond this task is kept.",
      z.object({
        outcome: z.string().describe("What happened, in a few sentences."),
      }),
      async (args) => {
        const model = options.tools.model;
        if (!model) return "No model is configured for debriefs.";
        const { debriefHandoff } = await import("./handoff-brief");
        const debriefed = await debriefHandoff({
          store,
          userId: actorId,
          sourceBotId: botId,
          taskId: threadId ?? "",
          outcomeText: String((args as { outcome?: unknown }).outcome ?? ""),
          model,
          apiKey: await options.tools.getApiKey?.().catch(() => null),
          environment: options.tools.environment,
        }).catch(() => ({ saved: 0, ids: [] as string[] }));
        return debriefed.saved > 0
          ? `Kept ${debriefed.saved} durable conclusion${debriefed.saved === 1 ? "" : "s"}.`
          : "Nothing durable to keep.";
      },
    ),

    tool(
      "task_note",
      "Jot a working note on THIS task (a scratchpad, not a fact): progress, findings, ids to remember while the job runs. Notes live in this conversation's episode and expire with it — they never leak into other tasks or long-term memory.",
      z.object({
        note: z.string().describe("The note, in a sentence or two."),
      }),
      async (args) => {
        if (!threadId) return "No task is open for notes.";
        const note = String((args as { note?: unknown }).note ?? "").trim();
        if (!note) return "An empty note keeps nothing.";
        const result = await store.saveMemory({
          userId: actorId,
          botId,
          content: note.slice(0, 2000),
          scope: "task",
          taskId: threadId,
          category: "scratchpad",
          source: "task_note",
        });
        return result.saved ? "Noted for this task." : "Already noted.";
      },
    ),

    tool(
      "task_notes",
      "Read back this task's working notes, newest last. Only this task's notes ever appear here.",
      z.object({}),
      async (args) => {
        if (!threadId) return "No task is open.";
        void args;
        const rows = await store.listMemories({
          userId: actorId,
          scope: "task",
          taskId: threadId,
          limit: 50,
        });
        if (rows.length === 0) return "No notes on this task yet.";
        return rows.map((row) => `- ${row.content}`).join("\n");
      },
    ),

    tool(
      "artifact_create",
      "Save a file for the person: notes, lists, documents, data. Returns its id.",
      z.object({
        name: z.string().max(120).describe("Filename, e.g. notes.md."),
        content: z
          .string()
          .max(2_000_000)
          .describe("Text content of the file."),
        mimeType: z.string().optional(),
      }),
      async (args) => {
        const a = args as {
          name?: string;
          content?: string;
          mimeType?: string;
        };
        const name = String(a.name ?? "untitled.md");
        const content = String(a.content ?? "");
        const mimeType = a.mimeType ?? "text/plain";
        const bytes = new TextEncoder().encode(content);

        /*
         * THE KEY IS DERIVED FROM THE ROW'S ID, NOT FROM THE NAME, AND THE ROW IS WRITTEN FIRST.
         *
         * The old code built a filename out of the name a model chose — `Date.now()` plus the name
         * with its punctuation replaced — and wrote the file at that path. Three things were wrong
         * with it, and only the first was visible. Two artifacts called `report.md` in the same
         * millisecond overwrote each other; the path was the identity, so a delete had to trust a
         * string that had been through a model's output; and the file was on a local disk, which is
         * the thing this tool is being moved away from.
         *
         * So: the row is written first to get an id, the key is built from that id, and the bytes
         * go under it. A failure between the two leaves a row with no bytes, which the Files page
         * shows as a file that will not open — visible, and cleanable. The other order leaves bytes
         * no row points at, and this interface has no `list` to find them with.
         */
        const id = await store.artifacts.create({
          userId: actorId,
          botId,
          name,
          // `url` is still not null in the schema and is what pre-driver rows are read through, so
          // it is filled with the key. It is not a path and nothing treats it as one except the
          // legacy branch, which only runs for rows with no key.
          url: "",
          storageKey: null,
          mimeType,
          size: bytes.byteLength,
          extractedText: content.slice(0, 200_000),
          source: "agent",
        });
        if (!id) return "Could not save.";

        const key = artifactStorageKey(id, name);
        if (blobs) {
          await blobs.put(key, bytes, mimeType);
          await store.artifacts.setStorageKey(id, actorId, key);
        } else {
          await mkdir(artifactsDir, { recursive: true });
          const safe = join(artifactsDir, key.replace(/^artifacts\//, ""));
          await mkdir(dirname(safe), { recursive: true });
          await writeFile(safe, bytes);
          await store.artifacts.setStorageKey(id, actorId, key);
        }
        return `Saved as ${name} (id ${id}).`;
      },
    ),

    tool(
      "artifact_list",
      "List saved files, newest first.",
      z.object({ limit: z.number().min(1).max(50).optional() }),
      async (args) => {
        const rows = await store.artifacts.list(
          actorId,
          (args as { limit?: number }).limit,
        );
        if (rows.length === 0) return "No saved files.";
        return rows.map((row) => `- [${row.id}] ${row.name}`).join("\n");
      },
    ),

    tool(
      "artifact_read",
      "Read a saved file's content by id or name.",
      z.object({ idOrName: z.string() }),
      async (args) => {
        const row = await store.artifacts.byIdOrName(
          actorId,
          String((args as { idOrName?: unknown }).idOrName ?? ""),
        );
        if (!row) return "No such file.";
        return (
          row.extractedText ?? `(no readable text, ${row.size ?? "?"} bytes)`
        );
      },
    ),

    tool(
      "artifact_delete",
      "Delete a saved file by id.",
      z.object({ id: z.string() }),
      async (args) =>
        (await store.artifacts.remove(
          actorId,
          String((args as { id?: unknown }).id ?? ""),
        ))
          ? "Deleted."
          : "No such file.",
    ),

    tool(
      "todo_add",
      "Record something to do: a task triaged from conversation, mail or a scheduled check.",
      z.object({
        title: z.string(),
        importance: z.enum(["HIGH", "MEDIUM", "LOW"]).optional(),
        sourceApp: z.string().optional(),
      }),
      async (args) => {
        const a = args as {
          title?: string;
          importance?: "HIGH" | "MEDIUM" | "LOW";
          sourceApp?: string;
        };
        const id = await store.todos.add({
          userId: actorId,
          title: String(a.title ?? ""),
          sourceApp: a.sourceApp,
          sourceRef: `manual-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          importance: a.importance,
          createdVia: "MANUAL",
        });
        return id ? `Recorded (id ${id}).` : "Could not record.";
      },
    ),

    tool(
      "todo_list",
      "List open things to do, most urgent first.",
      z.object({
        status: z.array(z.string()).optional(),
        limit: z.number().min(1).max(50).optional(),
      }),
      async (args) => {
        const rows = await store.todos.list({
          userId: actorId,
          status: (args as { status?: string[] }).status,
          limit: (args as { limit?: number }).limit,
        });
        if (rows.length === 0) return "Nothing open.";
        return rows
          .map((row) => `- [${row.id}] [${row.status}] ${row.title}`)
          .join("\n");
      },
    ),

    tool(
      "todo_update",
      "Move a task along: status, importance, or the result summary when done.",
      z.object({
        taskId: z.string(),
        status: z
          .enum(["OPEN", "IN_PROGRESS", "NEEDS_REVIEW", "DONE", "DISMISSED"])
          .optional(),
        resultSummary: z.string().optional(),
      }),
      async (args) => {
        const a = args as {
          taskId?: string;
          status?:
            | "OPEN"
            | "IN_PROGRESS"
            | "NEEDS_REVIEW"
            | "DONE"
            | "DISMISSED";
          resultSummary?: string;
        };
        if (a.status === "DONE" && !a.resultSummary) {
          return "Say what the outcome was (resultSummary) when marking DONE.";
        }
        return (await store.todos.update(actorId, String(a.taskId ?? ""), {
          status: a.status,
          resultSummary: a.resultSummary,
        }))
          ? "Updated."
          : "No such task.";
      },
    ),

    tool(
      "todo_delete",
      "Delete a task by id.",
      z.object({ taskId: z.string() }),
      async (args) =>
        (await store.todos.remove(
          actorId,
          String((args as { taskId?: unknown }).taskId ?? ""),
        ))
          ? "Deleted."
          : "No such task.",
    ),

    tool(
      "schedule",
      "Do something on a schedule: create, list, update or delete a cron job that runs a prompt as this person.",
      z.object({
        action: z.enum(["create", "list", "update", "delete"]),
        name: z.string().optional().describe("For create."),
        expression: z
          .string()
          .optional()
          .describe("Cron expression for create, e.g. '0 9 * * 1-5'."),
        timezone: z.string().optional(),
        prompt: z
          .string()
          .optional()
          .describe("What the Bot should do on each firing, for create."),
        jobId: z.string().optional().describe("For update/delete."),
        enabled: z.boolean().optional().describe("For update."),
      }),
      async (args) => {
        const a = args as {
          action?: string;
          name?: string;
          expression?: string;
          timezone?: string;
          prompt?: string;
          jobId?: string;
          enabled?: boolean;
        };
        if (a.action === "list") {
          const rows = await store.cron.list(actorId);
          if (rows.length === 0) return "No scheduled jobs.";
          return rows
            .map(
              (row) =>
                `- [${row.id}] ${row.enabled ? "on" : "off"} ${row.name} (${row.expression}) next: ${row.nextRunAt?.toISOString() ?? "never"}`,
            )
            .join("\n");
        }
        if (a.action === "create") {
          if (!a.name || !a.expression || !a.prompt) {
            return "Create needs a name, a cron expression and a prompt.";
          }
          let next: Date;
          try {
            // Croner loads on first schedule, not at boot: parsing is the only thing schedule
            // needs it for, and most boots never schedule anything.
            const { Cron } = await import("croner");
            const computed = new Cron(a.expression, {
              timezone: a.timezone ?? "UTC",
            }).nextRun();
            if (!computed) throw new Error("no next run");
            next = computed;
          } catch {
            return `That is not a valid cron expression: ${a.expression}`;
          }
          // The prompt travels on the row so the ticker can run it without asking again.
          const id = await store.cron.create({
            userId: actorId,
            botId,
            name: a.name,
            expression: a.expression,
            timezone: a.timezone ?? "UTC",
            triggerConfig: { prompt: a.prompt },
            nextRunAt: next,
          });
          return id
            ? `Scheduled (id ${id}), next run ${next.toISOString()}.`
            : "Could not schedule.";
        }
        if (!a.jobId) return "update/delete needs a jobId (see schedule list).";
        if (a.action === "delete") {
          return (await store.cron.remove(actorId, a.jobId))
            ? "Deleted."
            : "No such job.";
        }
        const patch: {
          name?: string;
          expression?: string;
          timezone?: string;
          enabled?: boolean;
          nextRunAt?: Date;
        } = {};
        if (a.name !== undefined) patch.name = a.name;
        if (a.timezone !== undefined) patch.timezone = a.timezone;
        if (a.enabled !== undefined) patch.enabled = a.enabled;
        if (a.expression !== undefined) {
          try {
            const { Cron } = await import("croner");
            const computed = new Cron(a.expression, {
              timezone: a.timezone ?? "UTC",
            }).nextRun();
            if (!computed) throw new Error("no next run");
            patch.nextRunAt = computed;
          } catch {
            return `That is not a valid cron expression: ${a.expression}`;
          }
          patch.expression = a.expression;
        }
        return (await store.cron.update(actorId, a.jobId, patch))
          ? "Updated."
          : "No such job.";
      },
    ),

    tool(
      "automations",
      "Run something when something happens in a connected app: create, list, update or delete an event automation that fires its prompt as you when a Composio trigger arrives.",
      z.object({
        action: z.enum(["create", "list", "update", "delete"]),
        name: z.string().optional().describe("For create."),
        apps: z
          .array(z.string())
          .optional()
          .describe(
            "App slugs this fires for, e.g. ['gmail']. Empty means every app. For create.",
          ),
        prompt: z
          .string()
          .optional()
          .describe("What you should do with the event, for create."),
        automationId: z.string().optional().describe("For update/delete."),
        enabled: z.boolean().optional().describe("For update."),
      }),
      async (args) => {
        const a = args as {
          action?: string;
          name?: string;
          apps?: string[];
          prompt?: string;
          automationId?: string;
          enabled?: boolean;
        };
        if (a.action === "list") {
          const rows = await store.automations.list(actorId);
          if (rows.length === 0) return "No automations.";
          return rows
            .map(
              (row) =>
                `- [${row.id}] ${row.enabled ? "on" : "off"} ${row.name} (apps: ${(row.apps ?? []).join(", ") || "all"})`,
            )
            .join("\n");
        }
        if (a.action === "create") {
          if (!a.name || !a.prompt) {
            return "Create needs a name and a prompt.";
          }
          const id = await store.automations.create({
            userId: actorId,
            botId,
            name: a.name,
            apps: a.apps,
            prompt: a.prompt,
          });
          return id ? `Automated (id ${id}).` : "Could not automate.";
        }
        if (!a.automationId) {
          return "update/delete needs an automationId (see automations list).";
        }
        if (a.action === "delete") {
          return (await store.automations.remove(actorId, a.automationId))
            ? "Deleted."
            : "No such automation.";
        }
        const patch: {
          name?: string;
          apps?: string[];
          prompt?: string;
          enabled?: boolean;
        } = {};
        if (a.name !== undefined) patch.name = a.name;
        if (a.apps !== undefined) patch.apps = a.apps;
        if (a.prompt !== undefined) patch.prompt = a.prompt;
        if (a.enabled !== undefined) patch.enabled = a.enabled;
        return (await store.automations.update(actorId, a.automationId, patch))
          ? "Updated."
          : "No such automation.";
      },
    ),

    tool(
      "get_chat_history",
      "Read what was said earlier in this conversation.",
      z.object({ limit: z.number().min(1).max(30).optional() }),
      async (args) => {
        if (!threadId || !options.tools.getThreadMessages) {
          return "No conversation history is available here.";
        }
        const limit = Math.min((args as { limit?: number }).limit ?? 10, 30);
        const messages = await options.tools.getThreadMessages(threadId);
        const slice = messages.slice(-limit);
        if (slice.length === 0) return "Nothing said yet.";
        return slice
          .map(
            (message) =>
              `${message.role ?? "unknown"}: ${textOf(message.content).slice(0, 2000)}`,
          )
          .join("\n---\n");
      },
    ),

    ...webTools(tool, {
      apiKey: options.tools.webSearchApiKey?.trim(),
      baseUrl: options.tools.webSearchBaseUrl?.trim(),
    }),
  ];
}

/**
 * Live web search and page reading, in the Remi shape.
 *
 * Offered only when the deployment configured a search endpoint: without one there is nothing
 * to call, and the browser remains the fallback. Speaks the Remi search service contract —
 * `POST {base}/v1/search/stream` (SSE: `sources_discovered` then `complete`) and
 * `POST {base}/v1/open` — with a Bearer key, the same endpoints Remi's own tools call, so
 * results here match what Remi produces for the same query.
 */
function webTools(
  tool: (
    name: string,
    description: string,
    parameters: z.ZodType,
    execute: (args: Record<string, never>) => Promise<string>,
  ) => GrantedTool,
  endpoint: { apiKey?: string; baseUrl?: string },
): GrantedTool[] {
  const apiKey = endpoint.apiKey?.trim();
  const baseUrl = (endpoint.baseUrl || "https://web.freeapi.space").replace(
    /\/+$/,
    "",
  );
  // No key and the default public endpoint is not usable without one: offering the tools would
  // hand the model two names whose every call fails as configuration. A deployment that sets
  // either variable gets both tools on the next run.
  if (!apiKey && !endpoint.baseUrl?.trim()) return [];

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
  };

  type SearchResult = {
    title?: unknown;
    url?: unknown;
    domain?: unknown;
    snippet?: unknown;
    content?: unknown;
    published_at?: unknown;
    author?: unknown;
  };
  type SearchComplete = {
    query?: unknown;
    mode?: unknown;
    results?: SearchResult[];
    meta?: {
      latency_ms?: unknown;
      cache_hit?: unknown;
    };
  };

  /** Read the `complete` event out of the search SSE stream. */
  async function readSearchStream(res: Response): Promise<SearchComplete> {
    const reader = res.body?.getReader();
    if (!reader) throw new Error("Search stream had no body.");
    const decoder = new TextDecoder();
    let buf = "";
    let complete: SearchComplete | undefined;
    let streamError: string | undefined;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true }).replace(/\r/g, "");
      const blocks = buf.split("\n\n");
      buf = blocks.pop() ?? "";
      for (const block of blocks) {
        let event = "";
        let data = "";
        for (const line of block.split("\n")) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) data = line.slice(5).trim();
        }
        if (!event || !data) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(data);
        } catch {
          continue;
        }
        if (
          event === "complete" &&
          typeof parsed === "object" &&
          parsed !== null
        ) {
          complete = parsed as SearchComplete;
        } else if (
          event === "error" &&
          typeof parsed === "object" &&
          parsed !== null
        ) {
          const message = (parsed as { message?: unknown }).message;
          if (typeof message === "string" && message) streamError = message;
        }
      }
    }
    if (streamError) throw new Error(streamError);
    if (!complete) throw new Error("Search ended without an answer.");
    return complete;
  }

  async function postSearchService(
    path: "/v1/search/stream" | "/v1/open",
    body: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<Response> {
    const send = () =>
      fetch(`${baseUrl}${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    const first = await send();
    if (first.status === 429) {
      let wait = 2000;
      try {
        const retry = (await first.json()) as { retry_after_ms?: unknown };
        if (
          typeof retry.retry_after_ms === "number" &&
          retry.retry_after_ms <= 5000
        ) {
          wait = retry.retry_after_ms;
        }
      } catch {
        // The retry body is a courtesy, not a contract: wait the default.
      }
      await new Promise((resolve) => setTimeout(resolve, wait));
      return send();
    }
    return first;
  }

  const formatResults = (
    finished: SearchComplete,
    fallbackQuery: string,
  ): string => {
    const results = Array.isArray(finished.results) ? finished.results : [];
    if (results.length === 0) {
      return "No results found. The domain filter may be too strict, or the topic has no indexed results.";
    }
    const mode = String(finished.mode ?? "normal");
    const latency =
      typeof finished.meta?.latency_ms === "number"
        ? ` | ${finished.meta.latency_ms}ms`
        : "";
    const cached = finished.meta?.cache_hit ? " | cached" : "";
    const maxLen = mode === "deep" ? 2500 : mode === "normal" ? 1200 : 500;
    const body = results
      .map((r, i) => {
        const text = String(r.content ?? r.snippet ?? "").trim();
        const preview =
          text.length > maxLen ? `${text.slice(0, maxLen)}…` : text;
        const domain = String(r.domain ?? "");
        const metaParts: string[] = [];
        if (typeof r.published_at === "string" && r.published_at) {
          metaParts.push(`Date: ${r.published_at.slice(0, 10)}`);
        }
        if (typeof r.author === "string" && r.author) {
          metaParts.push(`Author: ${r.author}`);
        }
        const metaLine =
          metaParts.length > 0 ? `   (${metaParts.join(" | ")})\n` : "";
        return `${i + 1}. ${String(r.title ?? "Untitled")} — ${domain}\n${metaLine}   ${preview}\n   URL: ${String(r.url ?? "")}`;
      })
      .join("\n\n");
    return `[Search: "${String(finished.query ?? fallbackQuery)}" | mode: ${mode} | ${results.length} results${latency}${cached}]\n\n${body}`;
  };

  return [
    tool(
      "web_search",
      "Search the live web for current facts, prices, docs and unfamiliar terms. Use mode='fast' for quick fact lookups (~1s, snippets only), 'normal' for most queries (fetches top pages), 'deep' only for broad multi-source research (slower, high token cost). Use freshness='day' or 'week' for breaking news.",
      z.object({
        query: z.string().describe("The search query."),
        mode: z
          .enum(["fast", "normal", "deep"])
          .optional()
          .describe("Result depth. Defaults to normal."),
        freshness: z
          .enum(["hour", "day", "week", "month", "year", "any"])
          .optional()
          .describe("Time filter. Use 'day' or 'week' for current events."),
        domains: z
          .array(z.string())
          .optional()
          .describe("Hard-restrict results to these domains."),
        max_results: z.number().min(1).max(30).optional(),
      }),
      async (args) => {
        const a = args as {
          query?: unknown;
          mode?: "fast" | "normal" | "deep";
          freshness?: string;
          domains?: string[];
          max_results?: number;
        };
        const query = String(a.query ?? "").trim();
        if (!query) return "Say what to search for.";
        const body: Record<string, unknown> = {
          query,
          mode: a.mode ?? "normal",
        };
        if (a.freshness) body.freshness = a.freshness;
        if (a.domains && a.domains.length > 0) body.domains = a.domains;
        if (a.max_results) body.max_results = a.max_results;
        try {
          const res = await postSearchService(
            "/v1/search/stream",
            body,
            30_000,
          );
          if (!res.ok) {
            if (res.status === 429) {
              return "Search rate limit hit. Try again shortly.";
            }
            if (res.status >= 500) {
              return "Search temporarily unavailable. Try again or answer from memory.";
            }
            return `Search failed with status ${res.status}.`;
          }
          return formatResults(await readSearchStream(res), query);
        } catch (error) {
          if (
            error instanceof Error &&
            (error.name === "AbortError" || error.name === "TimeoutError")
          ) {
            return "Search timed out after 30s. Try a simpler query or mode='fast'.";
          }
          return `Web search failed: ${error instanceof Error ? error.message : "the request failed."}`;
        }
      },
    ),

    tool(
      "web_open",
      "Read a web page's text by URL, when search snippets are not enough. Pass 'query' to focus extraction on a topic. Only http(s) URLs work.",
      z.object({
        url: z.string().describe("The page URL to read."),
        query: z.string().optional().describe("Topic to focus extraction on."),
        max_chars: z
          .number()
          .optional()
          .describe("Maximum characters to return."),
      }),
      async (args) => {
        const a = args as { url?: unknown; query?: string; max_chars?: number };
        const url = String(a.url ?? "").trim();
        if (!/^https?:\/\//.test(url)) {
          return "Give a full http(s) URL to read.";
        }
        // Google Sheets export directly: faster and more reliable than extraction.
        const sheetMatch =
          /docs\.google\.com\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/i.exec(url);
        if (sheetMatch?.[1]) {
          try {
            let gid = "";
            try {
              const parsed = new URL(url);
              gid = parsed.searchParams.get("gid") ?? "";
            } catch {
              // Not a parseable URL: fall through to the extraction service.
            }
            const csvUrl =
              `https://docs.google.com/spreadsheets/d/${sheetMatch[1]}/export?format=csv` +
              (gid ? `&gid=${gid}` : "");
            const sheetRes = await fetch(csvUrl, {
              headers: {
                "User-Agent":
                  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                Accept: "text/csv,text/plain,*/*",
              },
              signal: AbortSignal.timeout(15_000),
            });
            if (sheetRes.ok) {
              const csvText = await sheetRes.text();
              if (
                csvText &&
                !csvText.includes("<!DOCTYPE html") &&
                !csvText.includes("<html")
              ) {
                const limit = a.max_chars ?? 60_000;
                return `[Google Sheet (CSV Export) | ${csvText.length.toLocaleString()} chars]\nURL: ${url}\n\n${csvText.slice(0, limit)}`;
              }
            }
          } catch {
            // Fall through to the extraction service below.
          }
        }
        try {
          const body: Record<string, unknown> = { url };
          if (a.query) body.query = a.query;
          if (a.max_chars) body.max_chars = a.max_chars;
          const res = await postSearchService("/v1/open", body, 30_000);
          if (!res.ok) {
            if (res.status === 403) {
              return "That URL is blocked (private IP or restricted hostname). Try a public URL.";
            }
            if (res.status === 502) {
              return "Could not fetch page: it may be down, require login, or return a non-200 status.";
            }
            if (res.status === 504) {
              return "Page fetch timed out. The server may be slow or the URL invalid.";
            }
            return `Failed to open page with status ${res.status}.`;
          }
          const data = (await res.json()) as {
            url?: unknown;
            title?: unknown;
            content?: unknown;
            meta?: { latency_ms?: unknown; cache_hit?: unknown };
          };
          const text = String(data.content ?? "").trim();
          if (!text) return "That page had no readable text.";
          const limit = a.max_chars ?? 15_000;
          const latency =
            typeof data.meta?.latency_ms === "number"
              ? ` | ${data.meta.latency_ms}ms`
              : "";
          const cached = data.meta?.cache_hit ? " | cached" : "";
          return `[Page: ${String(data.title ?? url)}${latency}${cached}]\nURL: ${String(data.url ?? url)}\n\n${text.slice(0, limit)}`;
        } catch (error) {
          return `Could not read that page: ${error instanceof Error ? error.message : "the request failed."}`;
        }
      },
    ),
  ];
}
