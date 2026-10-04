import { z } from "zod";
import type { AgentProfileStore } from "../agents/profile-store";
import { ManagedAgentUnavailableError } from "../agents/profile-store";
import type { AgentActor, AgentProfile } from "../agents/profile-types";
import type { AuditStore } from "../audit";
import { recordAuditEvent } from "../audit";
import type { ChannelStore } from "../channels/routes";
import type { ComponentStore } from "../components/store";
import type { PolicyStore } from "../computer/policy-store";
import type { ExecutionModeStore } from "../execution-mode";
import type { PluginStore } from "../plugins/store";
import type { GrantedTool } from "../plugins/tools";
import type { UserInstructionsStore } from "../user-instructions";
import {
  isMascotColorId,
  isMascotShapeId,
  MASCOT_COLOR_IDS,
  MASCOT_SHAPE_IDS,
  type MascotColorId,
  type MascotShapeId,
} from "../../../shared/mascot-ids";
import { mascotChoiceForSeed } from "../../../shared/mascot-seed";

/**
 * The standing instructions a Bot made here may carry.
 *
 * The same 1000 the `POST /api/agents` route enforces, restated because these tools write through
 * the profile store rather than through that route and so do not meet its check. A coworker with a
 * 6000-character brief is not refused — it is created, and then every single turn it ever runs
 * carries 6000 characters of standing instructions in its system prompt. The limit is about what a
 * model can usefully be given on every turn, so a Bot that could ignore it was the wrong door.
 */
const ROLE_DESCRIPTION_LIMIT = 1000;

/** Cut to the limit, at a boundary, without splitting a character. See `channels/text.ts`. */
/**
 * The prompt a newly created coworker runs on.
 *
 * A built-in Bot in this product is a system prompt this deployment runs itself, so this is the
 * whole of what the new coworker is: who it is, what it is for, and that it answers the person it
 * was created for. Kept short and declarative on purpose — a role description written to be read in
 * a roster becomes a system prompt verbatim, and anything that reads like instructions to the
 * reader rather than to the Bot is noise at the front of the context.
 */
function coworkerSystemPrompt(input: {
  name: string;
  role: string;
  instructions?: string;
}): string {
  const lines = [
    `You are ${input.name}, a coworker on this deployment.`,
    "",
    input.role,
  ];
  if (input.instructions) {
    lines.push(
      "",
      "Standing instructions from the person who created you:",
      input.instructions,
    );
  }
  lines.push(
    "",
    "You were created to do one kind of work. Do that work well, use the tools you have, and say plainly when a tool is missing or refused rather than working around it.",
  );
  return lines.join("\n");
}

function boundRoleDescription(text: string): { text: string; was: number } {
  const trimmed = text.trim();
  const was = trimmed.length;
  if (was <= ROLE_DESCRIPTION_LIMIT) return { text: trimmed, was };

  /*
   * Grapheme by grapheme, because the limit is code units and the text may not be: a slice at 1000
   * would leave half a character behind whenever the brief is full of emoji, and that broken
   * character is handed to a model as content.
   */
  let kept = "";
  for (const { segment } of new Intl.Segmenter(undefined, {
    granularity: "grapheme",
  }).segment(trimmed)) {
    if (kept.length + segment.length > ROLE_DESCRIPTION_LIMIT) break;
    kept += segment;
  }
  const lastNewline = kept.lastIndexOf("\n");
  const lastSpace = kept.lastIndexOf(" ");
  if (lastNewline > ROLE_DESCRIPTION_LIMIT * 0.5) {
    kept = kept.slice(0, lastNewline);
  } else if (lastSpace > ROLE_DESCRIPTION_LIMIT * 0.5) {
    kept = kept.slice(0, lastSpace);
  }
  return { text: kept.trimEnd(), was };
}

/**
 * Remii's hands on the workspace itself: summon, add, delete and empower Bots, change the
 * person's settings, and manage connections — everything the screens do, as tools, so asking
 * Remii is enough and no page visit is required.
 *
 * Built per run with the run's Bot, person and thread bound in, the way `connect_app` and the
 * mind tools are. Every tool answers with a sentence, never a throw: a refusal mid-run is an
 * answer the model can say out loud, and the audit row is written either way. These run ONLY
 * for built-in agents through the signed run path; remote agents reach the read-only subset
 * the callback router names.
 *
 * Nothing here bypasses governance: creating, duplicating and deleting go through the profile
 * store's own access checks (package Bots are protected, other people's private Bots are
 * invisible), grants go through the plugin and component stores (which write their own audit
 * rows), and settings writes go through the same stores the settings screens use.
 */

/** What the trail files a grant row under, mirroring the plugin store's own mapping. */
function grantTarget(kind: string): string {
  if (kind === "tool") return "mcp_tool";
  if (kind === "component") return "component";
  if (kind === "connection" || kind === "app") return "composio_account";
  if (kind === "handoff") return "agent";
  return "skill";
}

/** Every tool name this module offers, for the remote-agent callback router. */
export const BOT_ADMIN_TOOL_NAMES = [
  "bot_summon",
  "bot_add",
  "bot_add_and_delegate",
  "bot_update",
  "bot_delete",
  "bot_read",
  "bot_list",
  "coworker_status",
  "bot_stop",
  "bot_pause",
  "bot_resume",
  "bot_grant",
  "bot_revoke",
  "update_settings",
  "connection_list",
  "connection_revoke",
] as const;

export type BotAdminStores = {
  profiles: AgentProfileStore;
  plugins: PluginStore;
  components: ComponentStore;
  channels: ChannelStore;
  executionModes: ExecutionModeStore;
  instructions: UserInstructionsStore;
  /** One person's Remi instance. Absent leaves model choice unavailable, nothing else. */
  instance?: {
    write: (
      userId: string,
      patch: { modelSlug?: string | null; modelProvider?: string | null },
    ) => Promise<{ modelSlug: string | null; modelProvider: string | null }>;
  };
  policyStore?: PolicyStore;
  getThreadMessages?: (
    threadId: string,
  ) => Promise<
    Array<{ role?: string; content?: unknown; createdAt?: unknown }>
  >;
  audit?: AuditStore;
  /** The person, resolved lazily so runs that never touch a Bot pay nothing for the role read. */
  loadActor: () => Promise<AgentActor>;
  /** Who the audit row names as the author of a change. */
  by: string;
  /**
   * Hand work to a Bot through the deployment's own handoff desk, in that Bot's own channel.
   *
   * Bound by the caller so this run's signed assertion — its thread, its run id, how deep it
   * already is — travels with the hop, and so the hop lands in the addressed Bot's own
   * conversation rather than a scratch thread. Absent leaves `bot_add_and_delegate` off, because a
   * creation tool that cannot delegate would only reproduce the empty-Bot flow it exists to end.
   */
  delegateToOwnChannel?: (input: {
    bot: string;
    task: string;
    constraints?: string;
    expecting?: string;
  }) => Promise<{ ok: boolean; answer: string }>;
  /**
   * End whatever run is live on a thread, by the thread the run is on.
   *
   * Bound by the caller rather than imported, for the same reason `delegateToOwnChannel` is: the
   * runner that owns liveness is the process's, and a tool that reached for its own would be a
   * second runner with a different idea of what is running.
   *
   * `runId` is optional and the answer says whether anything was actually stopped, because that is
   * the difference between "I halted Coco's turn" and "Coco had already finished". Absent leaves
   * `bot_stop` off rather than offering a control that silently does nothing.
   */
  stopRun?: (input: {
    threadId: string;
    runId?: string | null;
  }) => Promise<boolean>;
};

export function botAdminToolsFor(options: {
  botId: string;
  actorId: string;
  stores: BotAdminStores;
}): GrantedTool[] {
  const { botId, actorId, stores } = options;

  const tool = (
    name: string,
    description: string,
    parameters: z.ZodType,
    execute: (args: Record<string, never>) => Promise<string>,
  ): GrantedTool => ({
    name,
    description,
    parameters,
    ref: `bot/${name}`,
    execute: async (args: unknown) =>
      execute((args ?? {}) as Record<string, never>),
  });

  const audit = async (
    eventType:
      | "bot.created"
      | "bot.updated"
      | "bot.duplicated"
      | "bot.deleted"
      | "bot.stopped"
      | "bot.paused"
      | "bot.resumed"
      | "configuration.changed"
      | "mcp.account_disconnected",
    targetType: string,
    targetId: string,
    payload: Record<string, unknown>,
  ) => {
    if (!stores.audit) return;
    try {
      await recordAuditEvent(stores.audit, {
        eventType,
        targetType,
        targetId,
        actorUserId: actorId,
        payload: { actor: stores.by, ...payload },
      });
    } catch {
      // The trail must never fail the change it records.
    }
  };

  /**
   * The mascot this coworker is actually wearing, in the words a model reads best in.
   *
   * A row can hold one axis, both, or neither, and "neither" is every coworker nobody has dressed —
   * which draws from the seed rather than from the palette. So a report that only echoed the row
   * would describe a mascot nobody can see, and Remii would go looking for a collision that was
   * never on the screen. Resolving the seed here is what makes the roster it reports the roster a
   * person is looking at.
   */
  const mascotOf = (
    profile: AgentProfile,
  ): {
    shape: string;
    color: string;
    chosen: boolean;
  } => {
    const seeded = mascotChoiceForSeed(profile.avatarSeed || profile.id);
    const chosen =
      profile.mascot?.shape !== undefined ||
      profile.mascot?.color !== undefined;
    return {
      shape: profile.mascot?.shape ?? seeded.shape,
      color: profile.mascot?.color ?? seeded.color,
      chosen,
    };
  };

  /** The run states that mean this Bot is working right now, as opposed to waiting or finished. */
  const isWorking = (state: string | undefined): boolean =>
    state === "thinking" || state === "delegated";

  /** The Bot this run means, by id or by name as the roster spells it. */
  const resolveBot = async (
    raw: unknown,
  ): Promise<
    { ok: true; profile: AgentProfile } | { ok: false; refusal: string }
  > => {
    const want = String(raw ?? "")
      .trim()
      .toLowerCase();
    if (!want) {
      return { ok: false, refusal: "Name the Bot." };
    }
    let roster: AgentProfile[];
    try {
      roster = await stores.profiles.list(await stores.loadActor());
    } catch {
      return { ok: false, refusal: "The roster could not be read right now." };
    }
    const exact =
      roster.find((candidate) => candidate.id === want) ??
      roster.find((candidate) => candidate.name.toLowerCase() === want);
    if (exact) return { ok: true, profile: exact };
    const partial = roster.filter((candidate) =>
      candidate.name.toLowerCase().includes(want),
    );
    if (partial.length === 1) return { ok: true, profile: partial[0] };
    if (partial.length > 1) {
      return {
        ok: false,
        refusal: `Several Bots match: ${partial.map((candidate) => candidate.name).join(", ")}. Name one exactly.`,
      };
    }
    return {
      ok: false,
      refusal: `There is no such Bot. The roster holds: ${roster.map((candidate) => candidate.name).join(", ") || "nothing yet"}.`,
    };
  };

  const openChannel = async (profile: AgentProfile): Promise<string | null> => {
    try {
      const actor = await stores.loadActor();
      /*
       * `direct`, not `create`: the conversation between this person and this Bot is a
       * find-or-create, and the delegation path resolves that very same one. Creating here and
       * letting the handoff resolve another leaves the person with two channels for one Bot — one
       * holding the work, one empty — and the empty one is the one most likely to be opened first.
       */
      const channel =
        typeof (stores.channels as { direct?: unknown }).direct === "function"
          ? await stores.channels.direct(actor, profile.id)
          : await stores.channels.create(actor, [profile.id]);
      return channel.id;
    } catch {
      return null;
    }
  };

  /**
   * Let the Bot that just made this one hand work to it.
   *
   * A newly summoned or created Bot is useless to the run that made it if the very next
   * `delegate_bot` is refused: the creator would have to make the Bot, be told it may not hand
   * work to it, and then do the work itself — which is the exact flow this is here to prevent. The
   * grant is the same one `bot_grant` writes for a handoff, written here so making a Bot and being
   * able to delegate to it are one step rather than two the model has to know to connect.
   */
  const grantCreatorHandoff = async (profile: AgentProfile): Promise<void> => {
    try {
      await stores.plugins.grant("bot", profile.id, botId, stores.by);
    } catch {
      // A missing grant must not undo a Bot that was actually created; the run can still report
      // that the Bot exists and that delegation to it was refused.
    }
  };

  return [
    tool(
      "bot_summon",
      "Bring a template Bot into the workspace as a working copy and open a channel with it, so the person sees it in the sidebar roster immediately. Use this when the person asks for a coworker by role, or when part of their task needs a role you do not have.",
      z.object({
        template: z
          .string()
          .describe("The template's name or id, as the roster spells it."),
        name: z
          .string()
          .optional()
          .describe(
            "A different name for the copy. Defaults to the template's name.",
          ),
      }),
      async (args) => {
        const a = args as { template?: unknown; name?: string };
        const resolved = await resolveBot(a.template);
        if (!resolved.ok) return resolved.refusal;
        if (!resolved.profile.isSystemTemplate) {
          return `${resolved.profile.name} is already in the workspace — summoning is for templates. Open a channel with it instead.`;
        }
        const actor = await stores.loadActor();
        let copy: AgentProfile;
        try {
          copy = await stores.profiles.duplicate(actor, resolved.profile.id);
        } catch {
          return `That template could not be copied right now.`;
        }
        if (a.name?.trim()) {
          // A name of its own, so two copies of one template do not share one. The update
          // takes the whole profile, so the copy's own fields travel with the new name.
          try {
            const renamed = await stores.profiles.update(actor, copy.id, {
              name: a.name.trim(),
              title: copy.title,
              roleDescription: copy.roleDescription,
              visibility: copy.visibility,
            });
            copy = renamed;
          } catch {
            // The copy stands under the template's name; renaming is cosmetic.
          }
        }
        await audit("bot.duplicated", "bot", copy.id, {
          bot: botId,
          copiedFrom: resolved.profile.id,
        });
        await grantCreatorHandoff(copy);
        const channelId = await openChannel(copy);
        return channelId
          ? `${copy.name} is now in the workspace and its channel is open in the sidebar. Delegate the work to it with delegate_bot; it will do the work in its own channel.`
          : `${copy.name} is now in the workspace. Its channel could not be opened automatically — the person finds it under Agents. Delegate the work to it with delegate_bot.`;
      },
    ),

    tool(
      "bot_add",
      "Make a brand-new coworker from a name and a job description, open its channel in the sidebar, and make it a Bot you can delegate work to. Use this when no template covers what the person asked for. After this returns, call delegate_bot with the same name and the full task: the new Bot does the work in its own channel, not in this conversation.",
      z.object({
        name: z.string().describe("The coworker's name."),
        job: z
          .string()
          .describe(
            "What it is for, in a sentence or two. This becomes its standing role.",
          ),
        instructions: z
          .string()
          .optional()
          .describe(
            "Extra standing instructions beyond the job, if the person gave any.",
          ),
      }),
      async (args) => {
        const a = args as {
          name?: unknown;
          job?: unknown;
          instructions?: string;
        };
        const name = String(a.name ?? "").trim();
        const job = String(a.job ?? "").trim();
        if (!name || !job) {
          return "A new coworker needs a name and a job description.";
        }
        const actor = await stores.loadActor();
        const role = boundRoleDescription(
          a.instructions?.trim() ? `${job}\n\n${a.instructions.trim()}` : job,
        );
        let profile: AgentProfile;
        try {
          profile = await stores.profiles.create(actor, {
            name,
            title: name,
            roleDescription: role.text,
            visibility: "private",
            /*
             * THE COWORKER GETS A BRAIN, OR IT IS NOT A COWORKER.
             *
             * `create` takes one of three shapes, and this call used to name none of them: an
             * endpoint to run on, or a system prompt to run. With neither, the store refuses —
             * correctly, because a `built_in` row with an empty prompt is a coworker that
             * `registeredAgentFromRow` drops on the floor: it would appear on every screen and
             * answer nobody.
             *
             * That refusal only stayed invisible because of the `catch` below, so on a deployment
             * with no `MANAGED_AGENT_AG_UI_URL` — which is a supported configuration, and this one —
             * EVERY `bot_add` threw and every answer was the same unexplained sentence. The person
             * asked for a coworker twice, was refused twice, and was told nothing about why.
             *
             * So the standing role is promoted to the prompt. The role description is already the
             * thing that says what this coworker is for, written in the person's own words, and a
             * built-in Bot is exactly "a prompt this deployment runs itself". The name and the job
             * go in as well, because a model that knows its own name and its remit answers far
             * better than one given a bare duty.
             */
            systemPrompt: coworkerSystemPrompt({
              name,
              role: role.text,
              instructions: a.instructions?.trim(),
            }),
          });
        } catch (error) {
          /*
           * Named, because "could not be created right now" told the person nothing and left the
           * operator nothing either. The reason belongs in the log; the answer still does not leak
           * internals to a conversation.
           */
          console.error(
            `[bot_add] could not create "${name}": ${
              error instanceof Error
                ? (error.stack ?? error.message)
                : String(error)
            }`,
          );
          return `That coworker could not be created: ${
            error instanceof ManagedAgentUnavailableError
              ? "this deployment has no agent runtime to run a new coworker on, and no prompt was given to run it here."
              : "the reason is in the server log."
          }`;
        }
        await audit("bot.created", "bot", profile.id, { bot: botId, name });
        await grantCreatorHandoff(profile);
        const channelId = await openChannel(profile);
        const trimmed =
          role.was > ROLE_DESCRIPTION_LIMIT
            ? ` Its standing role was cut from ${role.was} to ${ROLE_DESCRIPTION_LIMIT} characters; put anything that fell off the end into the task you delegate, not into its instructions.`
            : "";
        return channelId
          ? `${name} is ready and its channel is open in the sidebar. Delegate the work to it with delegate_bot; it will do the work in its own channel, not here.${trimmed}`
          : `${name} is ready. Its channel could not be opened automatically — the person finds it under Agents. Delegate the work to it with delegate_bot.${trimmed}`;
      },
    ),

    ...(stores.delegateToOwnChannel
      ? [
          tool(
            "bot_add_and_delegate",
            "Create a new coworker for a job AND hand it the work in one step, so the new Bot does the job in its own channel instead of you doing it yourself. Use this whenever the person asks for work that needs a specialist. After this returns you are done with that task: the new Bot works in its own channel and saves its report as a file there.",
            z.object({
              name: z.string().describe("The coworker's name."),
              job: z
                .string()
                .describe(
                  "What it is for, in a sentence or two. This becomes its standing role.",
                ),
              task: z
                .string()
                .describe(
                  "The full task to hand this Bot, including anything it must produce.",
                ),
              instructions: z
                .string()
                .optional()
                .describe(
                  "Extra standing instructions beyond the job, if the person gave any.",
                ),
              constraints: z
                .string()
                .optional()
                .describe(
                  "Anything that bounds the work, such as scope, limits, or rules.",
                ),
              expecting: z
                .string()
                .optional()
                .describe(
                  "What a good result looks like, including any report to save.",
                ),
            }),
            async (args) => {
              const a = args as {
                name?: unknown;
                job?: unknown;
                instructions?: string;
                task?: unknown;
                constraints?: string;
                expecting?: string;
              };
              const name = String(a.name ?? "").trim();
              const job = String(a.job ?? "").trim();
              const task = String(a.task ?? "").trim();
              if (!name || !job || !task) {
                return "That needs a name, a job description, and the task to hand the new coworker.";
              }
              const actor = await stores.loadActor();
              const role = boundRoleDescription(
                a.instructions?.trim()
                  ? `${job}\n\n${a.instructions.trim()}`
                  : job,
              );
              let profile: AgentProfile;
              try {
                profile = await stores.profiles.create(actor, {
                  name,
                  title: name,
                  roleDescription: role.text,
                  visibility: "private",
                });
              } catch {
                return `That coworker could not be created right now.`;
              }
              await audit("bot.created", "bot", profile.id, {
                bot: botId,
                name,
              });
              await grantCreatorHandoff(profile);
              await openChannel(profile);
              /*
               * The long brief belongs in the TASK, not the standing role.
               *
               * This is where a security reviewer's instructions would run past the limit, and the
               * cut is silent unless it is said here: a coworker created with half a brief and a
               * task that does not carry the rest is a coworker that cannot do the job it was made
               * for, and nothing on screen says why. So the run is told the standing role is shorter
               * than the description it sent, and that the full brief belongs in the task it is
               * about to delegate.
               */
              const trimmed =
                role.was > ROLE_DESCRIPTION_LIMIT
                  ? ` Its standing role was cut from ${role.was} to ${ROLE_DESCRIPTION_LIMIT} characters, so put anything that fell off the end into the task you hand it.`
                  : "";
              const sent = await stores
                .delegateToOwnChannel?.({
                  bot: profile.id,
                  task,
                  ...(a.constraints ? { constraints: a.constraints } : {}),
                  ...(a.expecting ? { expecting: a.expecting } : {}),
                })
                .catch(() => ({ ok: false, answer: "" }));
              return sent?.ok
                ? `${name} is now in the workspace and is doing the work in its own channel, which is open in the sidebar. Tell the person who is handling it and stop: do not do the work yourself.${trimmed}`
                : `${name} was created and its channel is open, but the handoff did not land: ${sent?.answer || "unknown reason"} Tell the person it is ready but not running.${trimmed}`;
            },
          ),
        ]
      : []),

    tool(
      "bot_update",
      "Update or iterate on an existing coworker: change their name, job title, role description, standing instructions, or its mascot shape and colour. Remii can refine any coworker's behavior, instructions, responsibilities, and appearance as their role evolves.",
      z.object({
        bot: z
          .string()
          .describe("The coworker's name or id, as the roster spells it."),
        name: z
          .string()
          .optional()
          .describe("A new name for the coworker, if renaming."),
        title: z
          .string()
          .optional()
          .describe("A new title, e.g. 'Senior Financial Analyst'."),
        job: z.string().optional().describe("Updated job or role description."),
        instructions: z
          .string()
          .optional()
          .describe("Additional or updated standing instructions."),
        shape: z
          .enum(MASCOT_SHAPE_IDS)
          .optional()
          .describe(
            "A new body silhouette for the mascot. Leave it out to keep the current shape.",
          ),
        color: z
          .enum(MASCOT_COLOR_IDS)
          .optional()
          .describe(
            "A new colour for the mascot. Leave it out to keep the current colour. Pick one that is not already on the roster so nobody is confused about who is who.",
          ),
      }),
      async (args) => {
        const a = args as {
          bot?: unknown;
          name?: string;
          title?: string;
          job?: string;
          instructions?: string;
          shape?: string;
          color?: string;
        };
        const resolved = await resolveBot(a.bot);
        if (!resolved.ok) return resolved.refusal;
        if (resolved.profile.isSystemTemplate) {
          return `${resolved.profile.name} is a shared template. Summon it into the workspace with bot_summon first, then iterate on the copy.`;
        }
        const actor = await stores.loadActor();
        const current = resolved.profile;
        const name = a.name?.trim() || current.name;
        const title = a.title?.trim() || current.title;
        const composed = a.job?.trim()
          ? a.instructions?.trim()
            ? `${a.job.trim()}\n\n${a.instructions.trim()}`
            : a.job.trim()
          : a.instructions?.trim()
            ? `${current.roleDescription}\n\n${a.instructions.trim()}`
            : current.roleDescription;
        /*
         * Bounded here as at creation, and this is the tool where it matters most: it APPENDS.
         *
         * "Add these instructions" run five times grows the standing role five times, and every turn
         * the coworker ever runs carries the whole accumulated thing in its system prompt. A
         * coworker that quietly accumulates to 5000 characters of instructions is a coworker paying
         * for them on every message and getting worse at following any of them.
         */
        const role = boundRoleDescription(composed);
        const roleDescription = role.text;
        /*
         * The mascot is validated here rather than trusted, even though the schema already narrowed
         * it: the model writes both the tool description and the arguments, so the enum is a
         * convenience for it and not a guarantee, and a colour it invented would otherwise be stored
         * as somebody's coworker's face and drawn as the palette's fallback.
         *
         * Refused out loud rather than dropped, because a silent drop is indistinguishable from the
         * update having worked.
         */
        const before = mascotOf(current);
        const shape = a.shape?.trim();
        const color = a.color?.trim();
        if (shape !== undefined && !isMascotShapeId(shape)) {
          return `"${shape}" is not a mascot shape. The shapes are ${MASCOT_SHAPE_IDS.join(", ")}.`;
        }
        if (color !== undefined && !isMascotColorId(color)) {
          return `"${color}" is not a mascot colour. The colours are ${MASCOT_COLOR_IDS.join(", ")}.`;
        }
        const wantsMascot = shape !== undefined || color !== undefined;
        /*
         * Both axes travel together, always — including the one nobody asked about.
         *
         * `profiles.update` treats a supplied mascot as a whole replacement, because a partial write
         * would make clearing one axis impossible. So sending only the colour would reset the shape
         * to whatever the seed says, which is exactly the bug this tool would have created the first
         * time it was used to fix a colour. Carrying the resolved shape across keeps a recolour a
         * recolour.
         */
        const mascot = wantsMascot
          ? {
              shape: (shape ?? before.shape) as MascotShapeId,
              color: (color ?? before.color) as MascotColorId,
            }
          : undefined;
        try {
          await stores.profiles.update(actor, current.id, {
            name,
            title,
            roleDescription,
            visibility: current.visibility,
            ...(mascot ? { mascot } : {}),
          });
        } catch {
          return `Could not update ${current.name} right now.`;
        }
        await audit("bot.updated", "bot", current.id, {
          bot: botId,
          name,
          title,
          roleDescription,
          ...(mascot ? { mascot } : {}),
        });
        const changes: string[] = [];
        if (name !== current.name) changes.push(`name is now ${name}`);
        if (title !== current.title) changes.push(`title is now ${title}`);
        if (roleDescription !== current.roleDescription)
          changes.push("role and instructions updated");
        if (mascot) {
          const parts: string[] = [];
          if (shape !== undefined && shape !== before.shape)
            parts.push(`shape is now ${shape}`);
          if (color !== undefined && color !== before.color)
            parts.push(`colour is now ${color}`);
          changes.push(
            parts.length > 0
              ? `mascot ${parts.join(" and ")}`
              : "mascot asked for and already so",
          );
        }
        if (role.was > ROLE_DESCRIPTION_LIMIT) {
          changes.push(
            `standing role cut from ${role.was} to ${ROLE_DESCRIPTION_LIMIT} characters, so shorten it rather than appending again`,
          );
        }
        return `Updated ${name}: ${changes.join(", ") || "no changes"}.`;
      },
    ),

    tool(
      "bot_read",
      "Inspect an existing coworker in full: its mascot shape and colour, whether it is paused and why, its role description, standing instructions, granted skills, tools, and handoff targets.",
      z.object({
        bot: z
          .string()
          .describe("The coworker's name or id, as the roster spells it."),
      }),
      async (args) => {
        const resolved = await resolveBot((args as { bot?: unknown }).bot);
        if (!resolved.ok) return resolved.refusal;
        const p = resolved.profile;
        const [reachable, listForAgent] = await Promise.all([
          stores.plugins.botsReachableFrom(p.id).catch(() => [] as string[]),
          typeof (
            stores.plugins as unknown as {
              listForAgent?: (id: string) => Promise<unknown>;
            }
          ).listForAgent === "function"
            ? (
                stores.plugins as unknown as {
                  listForAgent: (id: string) => Promise<{
                    skills?: Array<{ name?: string; slug?: string }>;
                    tools?: Array<{ ref?: string; name?: string }>;
                  }>;
                }
              )
                .listForAgent(p.id)
                .catch(() => null)
            : Promise.resolve(null),
        ]);
        const mascot = mascotOf(p);
        const lines = [
          `Coworker: ${p.name} (ID: ${p.id})`,
          `Title: ${p.title}`,
          `Kind: ${p.isSystemTemplate ? "Shared template" : "Workspace coworker"}`,
          `Mascot: ${mascot.shape}, ${mascot.color}${
            mascot.chosen
              ? ""
              : " (not chosen by anybody; this is what its id gives it)"
          }`,
          ...(p.pausedAt
            ? [
                `Paused: yes${
                  p.pausedReason ? ` — ${p.pausedReason}` : ""
                } (it will not take work until bot_resume)`,
              ]
            : []),
          `Role & Instructions:\n${p.roleDescription || "None set"}`,
        ];
        if (reachable.length > 0) {
          lines.push(`Handoff targets: ${reachable.join(", ")}`);
        }
        if (listForAgent) {
          const skills =
            listForAgent.skills?.map((s) => s.name || s.slug) ?? [];
          if (skills.length > 0)
            lines.push(`Granted skills: ${skills.join(", ")}`);
          const tools = listForAgent.tools?.map((t) => t.ref || t.name) ?? [];
          if (tools.length > 0)
            lines.push(`Granted tools: ${tools.join(", ")}`);
        }
        return lines.join("\n");
      },
    ),

    tool(
      "bot_list",
      "List all coworkers and templates in the workspace, with their IDs, names, titles, mascot shape and colour, whether they are paused, and whether they are active workspace coworkers or shared templates. Read this before repainting anyone: two coworkers in the same colour are hard to tell apart on screen.",
      z.object({}),
      async () => {
        let roster: AgentProfile[];
        try {
          roster = await stores.profiles.list(await stores.loadActor());
        } catch {
          return "The roster could not be read right now.";
        }
        if (roster.length === 0) return "No coworkers in the workspace yet.";
        const workspaceBots = roster.filter((p) => !p.isSystemTemplate);
        const templates = roster.filter((p) => p.isSystemTemplate);
        const lines: string[] = ["Workspace Coworkers:"];
        if (workspaceBots.length === 0) {
          lines.push(
            "  (None yet — summon one from templates or add a new one)",
          );
        } else {
          for (const b of workspaceBots) {
            const mascot = mascotOf(b);
            lines.push(
              `- ${b.name} (${b.title}) [id: ${b.id}] — mascot ${mascot.shape}, ${mascot.color}${b.pausedAt ? " [PAUSED]" : ""} — ${b.roleDescription ? b.roleDescription.split("\n")[0] : ""}`,
            );
          }
        }
        if (templates.length > 0) {
          lines.push(
            "\nAvailable Templates (can be summoned with bot_summon):",
          );
          for (const t of templates) {
            const mascot = mascotOf(t);
            lines.push(
              `- ${t.name} (${t.title}) [template id: ${t.id}] — mascot ${mascot.shape}, ${mascot.color} — ${t.roleDescription ? t.roleDescription.split("\n")[0] : ""}`,
            );
          }
        }
        return lines.join("\n");
      },
    ),

    tool(
      "coworker_status",
      "Check what any coworker (or all coworkers) is currently doing: whether it is running a turn, waiting on the person, failed, or paused and why, its mascot, its channel's latest messages and topic. This is the first thing to call when asked how the workspace is doing, or what to stop.",
      z.object({
        bot: z
          .string()
          .optional()
          .describe(
            "The coworker's name or id to check. Leave empty or say 'all' to check all coworkers in the workspace.",
          ),
      }),
      async (args) => {
        const a = args as { bot?: string };
        const actor = await stores.loadActor();
        let roster: AgentProfile[];
        try {
          roster = await stores.profiles.list(actor);
        } catch {
          return "The coworker roster could not be loaded.";
        }
        const channelsPage = await stores.channels
          .list(actor, { limit: 50 })
          .catch(() => ({ channels: [] }));
        const want = a.bot?.trim();
        const isAll = !want || want.toLowerCase() === "all";

        if (!isAll) {
          const resolved = await resolveBot(want);
          if (!resolved.ok) return resolved.refusal;
          const target = resolved.profile;
          const matchingChannel = channelsPage.channels.find((ch) =>
            ch.agentIds.includes(target.id),
          );
          if (!matchingChannel) {
            return `${target.name} (${target.title}) has not had any conversations opened yet in this workspace. It is${target.pausedAt ? " paused" : " not paused"}.`;
          }
          /*
           * Read from `activity`, which is the one field on a channel summary that is a fact about a
           * run. This used to read `channel.busy`, which no type here has ever declared and nothing
           * has ever set — so the answer was always "Idle", for a coworker that was visibly working.
           * A chief of staff that reports every coworker idle is worse than one that reports nothing:
           * it is confidently wrong, and it is wrong about exactly the thing it was asked about.
           */
          const activity = matchingChannel.activity;
          const busyStatus = !activity
            ? "Idle"
            : isWorking(activity.state)
              ? `Working — ${activity.state}${activity.label ? `, ${activity.label}` : ""}`
              : activity.state === "waiting_on_you"
                ? `Waiting on the person${
                    activity.label ? ` — ${activity.label}` : ""
                  }`
                : activity.state === "failed"
                  ? `Last run failed${
                      activity.detail ? ` — ${activity.detail}` : ""
                    }`
                  : "Idle";
          const lastActivityStr = matchingChannel.lastMessageAt
            ? matchingChannel.lastMessageAt instanceof Date
              ? matchingChannel.lastMessageAt.toISOString()
              : String(matchingChannel.lastMessageAt)
            : "None";
          const mascot = mascotOf(target);
          const lines = [
            `Coworker: ${target.name} (${target.title})`,
            `Status: ${busyStatus}`,
            ...(target.pausedAt
              ? [
                  `Paused: yes${
                    target.pausedReason ? ` — ${target.pausedReason}` : ""
                  } — this coworker will not take work until bot_resume.`,
                ]
              : []),
            `Mascot: ${mascot.shape}, ${mascot.color}`,
            `Conversation topic: ${matchingChannel.summary || matchingChannel.name}`,
            `Last activity: ${lastActivityStr}`,
            `Latest message: ${matchingChannel.lastMessage || "None"}`,
          ];
          if (stores.getThreadMessages && matchingChannel.threadId) {
            try {
              const messages = await stores.getThreadMessages(
                matchingChannel.threadId,
              );
              if (messages.length > 0) {
                const recent = messages.slice(-4);
                lines.push("\nRecent exchange:");
                for (const msg of recent) {
                  const text =
                    typeof msg.content === "string"
                      ? msg.content
                      : JSON.stringify(msg.content ?? "");
                  lines.push(`- ${msg.role ?? "user"}: ${text.slice(0, 300)}`);
                }
              }
            } catch {
              // Optional
            }
          }
          return lines.join("\n");
        }

        const workspaceBots = roster.filter((p) => !p.isSystemTemplate);
        if (workspaceBots.length === 0) return "No workspace coworkers found.";
        const reports: string[] = ["Workspace Coworkers Status:"];
        for (const b of workspaceBots) {
          const ch = channelsPage.channels.find((c) =>
            c.agentIds.includes(b.id),
          );
          const busy =
            ch?.activity?.state === "thinking"
              ? " [working]"
              : ch?.activity?.state === "delegated"
                ? ` [with ${ch.activity.label ?? "another coworker"}]`
                : ch?.activity?.state === "waiting_on_you"
                  ? " [waiting on the person]"
                  : ch?.activity?.state === "failed"
                    ? " [last run failed]"
                    : " [idle]";
          const paused = b.pausedAt ? " [PAUSED]" : "";
          const mascot = mascotOf(b);
          const last = ch?.lastMessage
            ? ` — Latest: "${ch.lastMessage.slice(0, 100)}"`
            : "";
          const summary = ch?.summary ? ` (Topic: ${ch.summary})` : "";
          reports.push(
            `- ${b.name} (${b.title})${busy}${paused} — ${mascot.shape}, ${mascot.color}${summary}${last}`,
          );
        }
        return reports.join("\n");
      },
    ),

    ...(stores.stopRun
      ? [
          tool(
            "bot_stop",
            "Stop what a coworker is doing right now. Use this when a coworker is going the wrong way — the wrong task, the wrong recipient, something the person did not ask for — and the answer is to end the turn rather than wait for it. This ends the run in flight; it does not stop the coworker from being given work later, which is what bot_pause is for. Note what it cannot do: a tool the coworker has already called keeps going unless that tool honours cancellation, so anything already sent to an outside service stays sent.",
            z.object({
              bot: z
                .string()
                .describe(
                  "The coworker's name or id, as the roster spells it.",
                ),
              reason: z
                .string()
                .optional()
                .describe(
                  "Why it is being stopped. Recorded, and shown to the person, so the channel explains itself later.",
                ),
            }),
            async (args) => {
              const a = args as { bot?: unknown; reason?: string };
              const resolved = await resolveBot(a.bot);
              if (!resolved.ok) return resolved.refusal;
              const target = resolved.profile;
              if (target.isSystemTemplate) {
                return `${target.name} is a shared template and is not running anything.`;
              }
              if (target.id === botId) {
                return "That is me. I stop myself by ending this turn — say so and stop.";
              }
              if (target.pausedAt) {
                return `${target.name} is already paused, so it is not taking work. Use bot_resume to let it work again.`;
              }
              const channelsPage = await stores.channels
                .list(await stores.loadActor(), { limit: 50 })
                .catch(() => ({ channels: [] }));
              const channel = channelsPage.channels.find((ch) =>
                ch.agentIds.includes(target.id),
              );
              if (!channel?.threadId) {
                return `${target.name} has no conversation of its own, so there is no run to stop.`;
              }
              const wasWorking = isWorking(channel.activity?.state);
              /*
               * The thread comes from the channel the person owns, never from the model. That is the
               * whole authorisation: Remii can only ever name a thread it found by looking up a
               * coworker's own channel through the owner's own roster, so there is no thread id in
               * this tool's arguments that could point anywhere else.
               */
              const stopped = await stores
                .stopRun?.({ threadId: channel.threadId })
                .catch(() => false);
              if (!stopped) {
                return wasWorking
                  ? `${target.name} looked busy but the stop did not take — it may have finished in the same moment. Check coworker_status before saying it is stopped.`
                  : `${target.name} was not running anything, so nothing was stopped.`;
              }
              await audit("bot.stopped", "bot", target.id, {
                bot: botId,
                name: target.name,
                reason: a.reason?.trim() || null,
              });
              return `${target.name}'s turn was stopped.${
                a.reason?.trim() ? ` Reason: ${a.reason.trim()}` : ""
              } If it must not be given work again, use bot_pause.`;
            },
          ),
        ]
      : []),

    tool(
      "bot_pause",
      "Put a coworker on hold so it stops accepting work until it is resumed. Use this for a coworker that should not be running at all right now — one that keeps going the wrong way, or one whose work is no longer wanted. Work already in flight is not stopped by this; call bot_stop first if a turn is running. The person still sees its channel and history; it simply will not be given anything new.",
      z.object({
        bot: z
          .string()
          .describe("The coworker's name or id, as the roster spells it."),
        reason: z
          .string()
          .optional()
          .describe(
            "Why it is being held. Shown on the roster and in bot_read.",
          ),
      }),
      async (args) => {
        const a = args as { bot?: unknown; reason?: string };
        const resolved = await resolveBot(a.bot);
        if (!resolved.ok) return resolved.refusal;
        const target = resolved.profile;
        if (target.isSystemTemplate) {
          return `${target.name} is a shared template and cannot be paused.`;
        }
        if (target.id === botId) {
          return "I am the one holding the roster. I cannot pause myself; ask the person.";
        }
        if (target.pausedAt) {
          return `${target.name} is already paused${
            target.pausedReason ? ` — ${target.pausedReason}` : ""
          }.`;
        }
        const reason = a.reason?.trim() || null;
        try {
          await stores.profiles.update(await stores.loadActor(), target.id, {
            name: target.name,
            title: target.title,
            roleDescription: target.roleDescription,
            visibility: target.visibility,
            paused: true,
            pausedReason: reason,
          });
        } catch {
          return `${target.name} could not be paused right now.`;
        }
        await audit("bot.paused", "bot", target.id, {
          bot: botId,
          name: target.name,
          reason,
        });
        return `${target.name} is paused and will not take work${
          reason ? ` — ${reason}` : ""
        }. Resume it with bot_resume.`;
      },
    ),

    tool(
      "bot_resume",
      "Release a paused coworker so it takes work again. Only a paused coworker can be resumed; on any other this does nothing and says so.",
      z.object({
        bot: z
          .string()
          .describe("The coworker's name or id, as the roster spells it."),
      }),
      async (args) => {
        const resolved = await resolveBot((args as { bot?: unknown }).bot);
        if (!resolved.ok) return resolved.refusal;
        const target = resolved.profile;
        if (target.isSystemTemplate) {
          return `${target.name} is a shared template and cannot be paused or resumed.`;
        }
        if (!target.pausedAt) {
          return `${target.name} is not paused; it is already taking work.`;
        }
        const reason = target.pausedReason;
        try {
          await stores.profiles.update(await stores.loadActor(), target.id, {
            name: target.name,
            title: target.title,
            roleDescription: target.roleDescription,
            visibility: target.visibility,
            paused: false,
          });
        } catch {
          return `${target.name} could not be resumed right now.`;
        }
        await audit("bot.resumed", "bot", target.id, {
          bot: botId,
          name: target.name,
          wasPausedFor: reason,
        });
        return `${target.name} is working again${
          reason ? `. It was paused because: ${reason}` : "."
        }`;
      },
    ),

    tool(
      "bot_delete",
      "Remove a workspace coworker the person no longer wants. Package templates cannot be deleted, only workspace copies.",
      z.object({
        bot: z
          .string()
          .describe("The Bot's name or id, as the roster spells it."),
      }),
      async (args) => {
        const resolved = await resolveBot((args as { bot?: unknown }).bot);
        if (!resolved.ok) return resolved.refusal;
        if (resolved.profile.isSystemTemplate) {
          return `${resolved.profile.name} is a shared template and cannot be deleted.`;
        }
        try {
          await stores.profiles.softDelete(
            await stores.loadActor(),
            resolved.profile.id,
          );
        } catch {
          return `${resolved.profile.name} could not be removed — it may belong to somebody else or be protected.`;
        }
        await audit("bot.deleted", "bot", resolved.profile.id, {
          bot: botId,
          name: resolved.profile.name,
        });
        return `${resolved.profile.name} is gone from the workspace.`;
      },
    ),

    tool(
      "bot_grant",
      "Give a Bot a capability it needs for the task: a skill, an app tool, a connected app account/permission, a component to answer with, or another Bot it may hand work to.",
      z.object({
        bot: z
          .string()
          .describe("The Bot's name or id, as the roster spells it."),
        kind: z
          .enum(["skill", "tool", "component", "connection", "handoff", "app"])
          .describe(
            "What kind of capability this is: skill, tool, component, connection, handoff, or app.",
          ),
        ref: z
          .string()
          .describe(
            "What to grant: a skill slug, an app name (e.g. gmail, slack), an app tool ref (server/tool), a component name, a connection id (see connection_list), or the target Bot's name for handoff.",
          ),
      }),
      async (args) => {
        const a = args as { bot?: unknown; kind?: string; ref?: unknown };
        const resolved = await resolveBot(a.bot);
        if (!resolved.ok) return resolved.refusal;
        const ref = String(a.ref ?? "").trim();
        if (!ref) return "Say what to grant.";
        const target = resolved.profile;
        try {
          switch (a.kind) {
            case "skill":
              await stores.plugins.grant("skill", ref, target.id, stores.by);
              break;
            case "tool":
              await stores.plugins.grant("mcp", ref, target.id, stores.by);
              break;
            case "component":
              await stores.components.grant(ref, target.id);
              break;
            case "app":
            case "connection": {
              const actor = await stores.loadActor();
              const want = ref.toLowerCase().replace(/^composio-/, "");
              const brokered = await stores.plugins
                .brokeredConnectionsFor(actor.id)
                .catch(() => []);
              const match = brokered.find(
                (row) =>
                  row.serverId.toLowerCase() === want ||
                  row.serverId.toLowerCase() === `composio-${want}` ||
                  row.serverId.toLowerCase().replace(/^composio-/, "") === want,
              );
              if (match) {
                const toolkit = match.serverId.replace(/^composio-/, "");
                const accounts = await stores.plugins
                  .listBrokeredAccounts({ toolkit, userId: actor.id })
                  .catch(() => []);
                for (const account of accounts) {
                  await stores.plugins.grantAccountToAgent({
                    connectionId: account.id,
                    agentId: target.id,
                    userId: actor.id,
                  });
                }
                const pluginAny = stores.plugins as unknown as {
                  grantServer?: (
                    serverId: string,
                    agentId: string,
                    by: string,
                  ) => Promise<unknown>;
                };
                if (typeof pluginAny.grantServer === "function") {
                  await pluginAny
                    .grantServer(match.serverId, target.id, stores.by)
                    .catch(() => {});
                }
              } else {
                await stores.plugins.grantAccountToAgent({
                  connectionId: ref,
                  agentId: target.id,
                  userId: actor.id,
                });
              }
              break;
            }
            case "handoff": {
              const other = await resolveBot(ref);
              if (!other.ok) return other.refusal;
              await stores.plugins.grant(
                "bot",
                other.profile.id,
                target.id,
                stores.by,
              );
              break;
            }
            default:
              return "Grant kind must be one of: skill, tool, component, connection, handoff, app.";
          }
        } catch {
          return `That grant did not land — the ${a.kind} named may not exist. Say what is missing and carry on another way.`;
        }
        await audit("configuration.changed", grantTarget(a.kind), target.id, {
          bot: botId,
          change: "bot_granted",
          kind: a.kind,
          ref,
        });
        return `${target.name} now holds that ${a.kind}.`;
      },
    ),

    tool(
      "bot_revoke",
      "Take a capability back from a Bot: a skill, an app tool, a connected app account/permission, a component, or another Bot it may hand work to.",
      z.object({
        bot: z
          .string()
          .describe("The Bot's name or id, as the roster spells it."),
        kind: z
          .enum(["skill", "tool", "component", "connection", "handoff", "app"])
          .describe(
            "What kind of capability this is: skill, tool, component, connection, handoff, or app.",
          ),
        ref: z.string().describe("What to take back, as bot_grant spells it."),
      }),
      async (args) => {
        const a = args as { bot?: unknown; kind?: string; ref?: unknown };
        const resolved = await resolveBot(a.bot);
        if (!resolved.ok) return resolved.refusal;
        const ref = String(a.ref ?? "").trim();
        if (!ref) return "Say what to take back.";
        const target = resolved.profile;
        try {
          switch (a.kind) {
            case "skill":
              await stores.plugins.revoke("skill", ref, target.id, stores.by);
              break;
            case "tool":
              await stores.plugins.revoke("mcp", ref, target.id, stores.by);
              break;
            case "component":
              await stores.components.revoke(ref, target.id, stores.by);
              break;
            case "app":
            case "connection": {
              const actor = await stores.loadActor();
              const want = ref.toLowerCase().replace(/^composio-/, "");
              const brokered = await stores.plugins
                .brokeredConnectionsFor(actor.id)
                .catch(() => []);
              const match = brokered.find(
                (row) =>
                  row.serverId.toLowerCase() === want ||
                  row.serverId.toLowerCase() === `composio-${want}` ||
                  row.serverId.toLowerCase().replace(/^composio-/, "") === want,
              );
              if (match) {
                const toolkit = match.serverId.replace(/^composio-/, "");
                const accounts = await stores.plugins
                  .listBrokeredAccounts({ toolkit, userId: actor.id })
                  .catch(() => []);
                for (const account of accounts) {
                  await stores.plugins.revokeAccountFromAgent({
                    connectionId: account.id,
                    agentId: target.id,
                    userId: actor.id,
                  });
                }
                const pluginAny = stores.plugins as unknown as {
                  revokeServer?: (
                    serverId: string,
                    agentId: string,
                    by: string,
                  ) => Promise<unknown>;
                };
                if (typeof pluginAny.revokeServer === "function") {
                  await pluginAny
                    .revokeServer(match.serverId, target.id, stores.by)
                    .catch(() => {});
                }
              } else {
                await stores.plugins.revokeAccountFromAgent({
                  connectionId: ref,
                  agentId: target.id,
                  userId: actor.id,
                });
              }
              break;
            }
            case "handoff": {
              const other = await resolveBot(ref);
              if (!other.ok) return other.refusal;
              await stores.plugins.revoke(
                "bot",
                other.profile.id,
                target.id,
                stores.by,
              );
              break;
            }
            default:
              return "Revoke kind must be one of: skill, tool, component, connection, handoff, app.";
          }
        } catch {
          return `That revocation did not land. Say what is missing and carry on.`;
        }
        await audit("configuration.changed", grantTarget(a.kind), target.id, {
          bot: botId,
          change: "bot_revoked",
          kind: a.kind,
          ref,
        });
        return `${target.name} no longer holds that ${a.kind}.`;
      },
    ),

    tool(
      "update_settings",
      "Change how this person's coworkers behave for them, when they ask in words rather than opening Settings. Execution mode decides whether Bots act directly or confirm external actions first; standing instructions are what every coworker is told about how the person wants things done; model_slug picks which model their turns answer on (empty inherits the deployment).",
      z.object({
        execution_mode: z
          .enum(["direct", "ask-first"])
          .optional()
          .describe("Act directly, or confirm external actions first."),
        standing_instructions: z
          .string()
          .optional()
          .describe(
            "Replacement standing instructions, or empty to clear them.",
          ),
        model_slug: z
          .string()
          .optional()
          .describe(
            "Model slug for this person's turns, e.g. 'deepseek-chat', or empty to inherit the deployment default.",
          ),
        model_provider: z
          .enum(["openai", "anthropic"])
          .optional()
          .describe(
            "Provider the slug belongs to. Defaults to the deployment provider.",
          ),
        action_policy: z
          .string()
          .optional()
          .describe(
            "Browser safety policy / boundaries rules, or empty to clear.",
          ),
      }),
      async (args) => {
        const a = args as {
          execution_mode?: "direct" | "ask-first";
          standing_instructions?: string;
          model_slug?: string;
          model_provider?: "openai";
          action_policy?: string;
        };
        const changed: string[] = [];
        if (a.execution_mode !== undefined) {
          try {
            await stores.executionModes.write(actorId, a.execution_mode);
            changed.push(`execution mode is now ${a.execution_mode}`);
          } catch {
            return "That execution mode did not save.";
          }
        }
        if (a.standing_instructions !== undefined) {
          try {
            await stores.instructions.write(actorId, a.standing_instructions);
            changed.push(
              a.standing_instructions.trim()
                ? "standing instructions saved"
                : "standing instructions cleared",
            );
          } catch {
            return "Those instructions did not save — they may be over the length limit.";
          }
        }
        if (a.action_policy !== undefined) {
          if (!stores.policyStore) {
            return "Action policy is not available on this deployment.";
          }
          try {
            const current = stores.policyStore.get(actorId);
            const rules = a.action_policy.trim()
              ? a.action_policy
                  .split("\n")
                  .map((r) => r.trim())
                  .filter(Boolean)
              : [];
            await stores.policyStore.set(
              {
                mode: current?.mode ?? "enforce",
                deny: rules,
                allow: current?.allow ?? ["true"],
              },
              stores.by,
              actorId,
            );
            changed.push(
              rules.length > 0
                ? "browser action policy updated"
                : "browser action policy cleared",
            );
          } catch {
            return "That action policy did not save.";
          }
        }
        if (a.model_slug !== undefined || a.model_provider !== undefined) {
          if (!stores.instance) {
            return "Model choice is not available on this deployment.";
          }
          try {
            const saved = await stores.instance.write(actorId, {
              ...(a.model_slug !== undefined
                ? { modelSlug: a.model_slug.trim() || null }
                : {}),
              ...(a.model_provider !== undefined
                ? { modelProvider: a.model_provider }
                : {}),
            });
            changed.push(
              saved.modelSlug
                ? `model is now ${saved.modelSlug}`
                : "model inherits the deployment default",
            );
          } catch {
            return "That model choice did not save.";
          }
        }
        if (changed.length === 0) {
          return "Say what to change: execution_mode, standing_instructions, action_policy, model_slug, or a combination.";
        }
        await audit("configuration.changed", "user_preferences", actorId, {
          bot: botId,
          changed,
        });
        return `Done: ${changed.join("; ")}.`;
      },
    ),

    tool(
      "connection_list",
      "List this person's connected app accounts, with the app names connection_revoke and bot_grant need.",
      z.object({}),
      async () => {
        const actor = await stores.loadActor();
        const [held, brokered] = await Promise.all([
          stores.plugins.connectionsFor(actor.id).catch(() => []),
          stores.plugins.brokeredConnectionsFor(actor.id).catch(() => []),
        ]);
        const lines = [
          ...held.map(
            (connection) =>
              `- ${connection.serverId}${connection.scope ? ` (${connection.scope})` : ""}`,
          ),
        ];
        for (const row of brokered) {
          const toolkit = row.serverId.replace(/^composio-/, "");
          const accounts = await stores.plugins
            .listBrokeredAccounts({ toolkit, userId: actor.id })
            .catch(() => []);
          if (accounts.length === 0) {
            lines.push(`- ${toolkit}`);
          } else {
            for (const account of accounts) {
              lines.push(
                `- ${toolkit}${account.label ? ` — ${account.label}` : ""} (id ${account.id})`,
              );
            }
          }
        }
        return lines.length > 0
          ? lines.join("\n")
          : "No apps connected yet. Ask the person to connect one with connect_app.";
      },
    ),

    tool(
      "connection_revoke",
      "Disconnect one of this person's app accounts by app name (see connection_list). Ends every account held at that app.",
      z.object({
        connection: z
          .string()
          .describe(
            "The app name, e.g. gmail, or a connection id from connection_list.",
          ),
      }),
      async (args) => {
        const want = String((args as { connection?: unknown }).connection ?? "")
          .trim()
          .toLowerCase()
          .replace(/^composio-/, "");
        if (!want) return "Say which connection to remove.";
        const actor = await stores.loadActor();
        const brokered = await stores.plugins
          .brokeredConnectionsFor(actor.id)
          .catch(() => []);
        const match = brokered.find(
          (row) =>
            row.serverId.toLowerCase() === want ||
            row.serverId.toLowerCase() === `composio-${want}` ||
            row.serverId.toLowerCase().replace(/^composio-/, "") === want,
        );
        if (!match) {
          return "No connected account matches that. See connection_list for what is connected.";
        }
        const toolkit = match.serverId.replace(/^composio-/, "");
        try {
          await stores.plugins.disconnectBrokered({
            toolkit,
            userId: actor.id,
            by: stores.by,
            reason: "self",
          });
        } catch {
          return "That connection could not be removed right now.";
        }
        await audit("mcp.account_disconnected", "mcp_server", toolkit, {
          bot: botId,
        });
        return `Disconnected ${toolkit}.`;
      },
    ),
  ];
}
