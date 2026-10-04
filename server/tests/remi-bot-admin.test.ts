import { describe, expect, test } from "bun:test";
import type { AgentProfile } from "../src/agents/profile-types";
import {
  BOT_ADMIN_TOOL_NAMES,
  botAdminToolsFor,
  type BotAdminStores,
} from "../src/remi/bot-admin";
import { REMII_AGENT_ID } from "../../shared/remii";

/**
 * Remii's workspace powers, minus every database.
 *
 * The stores are fakes holding plain arrays, because what pins the contract is the tool
 * behavior — name resolution, template protection, refusal sentences, audit rows — not the
 * SQL underneath, which already has its own tests. A tool that throws here is a run that ends
 * with nothing said, so every failure path below asserts a sentence.
 */

const ACTOR = { id: "user-1", role: "user" as const };

function template(id: string, name: string): AgentProfile {
  return {
    id,
    name,
    title: `${name} title`,
    roleDescription: `${name} job`,
    avatarSeed: id,
    visibility: "public",
    ownerUserId: null,
    isSystemTemplate: true,
    systemOwned: true,
    hidden: false,
    deletedAt: null,
    endpoint: null,
  };
}

function workspace(id: string, name: string): AgentProfile {
  return { ...template(id, name), isSystemTemplate: false, systemOwned: false };
}

function fakes(
  delegate?: (input: {
    bot: string;
    task: string;
    constraints?: string;
    expecting?: string;
  }) => Promise<{ ok: boolean; answer: string }>,
) {
  const state = {
    roster: [
      template("tpl-1", "Research Desk"),
      workspace("bot-1", "Helper"),
    ] as AgentProfile[],
    grants: [] as { kind: string; ref: string; agentId: string }[],
    channels: [] as string[],
    settings: {} as Record<string, string>,
    audit: [] as { eventType: string; targetId: string }[],
    delegations: [] as { bot: string; task: string }[],
    /** Every role description written, so a bound can be asserted rather than assumed. */
    roles: [] as string[],
  };
  let created = 0;
  const stores: BotAdminStores = {
    profiles: {
      list: async () => state.roster.filter((profile) => !profile.deletedAt),
      duplicate: async (_actor, id) => {
        const source = state.roster.find((profile) => profile.id === id);
        if (!source) throw new Error("no such bot");
        const copy = workspace(`copy-of-${id}`, source.name);
        state.roster.push(copy);
        return copy;
      },
      create: async (_actor, input) => {
        created += 1;
        const profile = workspace(`new-${created}`, input.name);
        // The column is unbounded text, so a bound enforced only in the route is no bound here.
        state.roles.push(input.roleDescription);
        state.roster.push(profile);
        return profile;
      },
      update: async (_actor, id, input) => {
        const profile = state.roster.find((candidate) => candidate.id === id);
        if (!profile) throw new Error("no such bot");
        if (input.roleDescription !== undefined) {
          state.roles.push(input.roleDescription);
        }
        Object.assign(profile, input);
        return profile;
      },
      softDelete: async (_actor, id) => {
        const profile = state.roster.find((candidate) => candidate.id === id);
        if (!profile || profile.isSystemTemplate) throw new Error("protected");
        profile.deletedAt = new Date();
      },
    } as never,
    plugins: {
      grant: async (kind, ref, agentId) => {
        state.grants.push({ kind, ref, agentId });
      },
      revoke: async (kind, ref, agentId) => {
        state.grants = state.grants.filter(
          (grant) =>
            !(
              grant.kind === kind &&
              grant.ref === ref &&
              grant.agentId === agentId
            ),
        );
      },
      botsReachableFrom: async () => ["bot-1"],
      grantAccountToAgent: async (input: {
        connectionId: string;
        agentId: string;
      }) => {
        state.grants.push({
          kind: "account",
          ref: input.connectionId,
          agentId: input.agentId,
        });
      },
      revokeAccountFromAgent: async (input: {
        connectionId: string;
        agentId: string;
      }) => {
        state.grants = state.grants.filter(
          (grant) =>
            !(
              grant.kind === "account" &&
              grant.ref === input.connectionId &&
              grant.agentId === input.agentId
            ),
        );
      },
      grantServer: async (serverId: string, agentId: string) => {
        state.grants.push({ kind: "server", ref: serverId, agentId });
      },
      revokeServer: async (serverId: string, agentId: string) => {
        state.grants = state.grants.filter(
          (grant) =>
            !(
              grant.kind === "server" &&
              grant.ref === serverId &&
              grant.agentId === agentId
            ),
        );
      },
      connectionsFor: async () => [
        { serverId: "drive", scope: "", connectedAt: "" },
      ],
      brokeredConnectionsFor: async () => [
        {
          serverId: "composio-gmail",
          scope: "",
          connectedAt: "",
          verified: true,
          verifiedAt: null,
          probe: null,
          checkable: true,
        },
      ],
      listBrokeredAccounts: async () => [
        {
          id: "conn-1",
          accountId: "acc-1",
          label: "me@example.com",
          connectedAt: "",
          verified: true,
          verifiedAt: null,
          grantedAgents: [],
        },
      ],
      disconnectBrokered: async () => ({ vendorRevocationRequested: false }),
    } as never,
    components: {
      grant: async () => {},
      revoke: async () => {},
    } as never,
    channels: {
      create: async (_actor: unknown, agentIds: string[]) => {
        state.channels.push(...agentIds);
        return { id: "channel-1", agentIds };
      },
      direct: async (_actor: unknown, agentId: string) => {
        if (!state.channels.includes(agentId)) state.channels.push(agentId);
        return { id: `channel-for-${agentId}`, agentIds: [agentId] };
      },
      list: async () => ({
        channels: [
          {
            id: "channel-1",
            name: "Helper",
            agentIds: ["bot-1"],
            threadId: "thread-1",
            summary: "Analyzing Q3 reports",
            lastMessage: "Finished reviewing the revenue numbers.",
            lastMessageAt: "2026-09-24T03:00:00Z",
            lastMessageAgentId: "bot-1",
            createdAt: "2026-09-24T01:00:00Z",
            pinned: false,
            busy: false,
            active: true,
          },
        ],
        nextCursor: null,
      }),
    } as never,
    executionModes: {
      read: async () => null,
      write: async (_userId: string, mode: "direct" | "ask-first" | null) =>
        mode,
    },
    instructions: {
      read: async () => null,
      write: async (_userId: string, text: string) => text,
    },
    policyStore: {
      set: async (policy: any, _by?: string, _userId?: string) => {
        state.settings.actionPolicy = (policy.deny ?? []).join("\n");
      },
      get: () => ({
        mode: "enforce",
        deny: state.settings.actionPolicy ? [state.settings.actionPolicy] : [],
        allow: ["true"],
      }),
    },
    getThreadMessages: async () => [
      { role: "user", content: "Review revenue numbers" },
      { role: "assistant", content: "Working on the revenue analysis now." },
    ],
    audit: {
      insert: async (event: { eventType: string; targetId: string }) => {
        state.audit.push(event);
      },
    } as never,
    loadActor: async () => ACTOR,
    by: ACTOR.id,
    delegateToOwnChannel:
      delegate ??
      (async (input) => {
        state.delegations.push({ bot: input.bot, task: input.task });
        return { ok: true, answer: input.bot };
      }),
  };
  const tools = Object.fromEntries(
    botAdminToolsFor({
      botId: REMII_AGENT_ID,
      actorId: ACTOR.id,
      stores,
    }).map((tool) => [tool.name, tool]),
  );
  return { state, tools };
}

describe("bot admin tool names", () => {
  test("the router knows every offered name", () => {
    const { tools } = fakes();
    for (const name of BOT_ADMIN_TOOL_NAMES) {
      expect(tools[name]).toBeDefined();
    }
  });
});

/*
 * A standing role is capped here, because the cap in `POST /api/agents` is not met by this door.
 *
 * These tools write through the profile store, so they never see the route's 1000-character check.
 * The column is unbounded `text`, so nothing downstream refuses either: a coworker made with a
 * 1347-character brief is created happily, and then carries all 1347 characters of it in the system
 * prompt of every single turn it ever runs. The number that produced the reported error is the
 * brief itself — a security reviewer's instructions are long because the job is broad — so this is
 * the ordinary case, not an edge.
 */
describe("the standing role a new coworker may carry", () => {
  /** The length from the error a person actually hit. */
  const REPORTED = 1347;

  test("bot_add cuts an over-length role rather than writing all of it", async () => {
    const { state, tools } = fakes();
    const said = await tools.bot_add.execute({
      name: "Eventum Security Bot",
      job: "r".repeat(REPORTED),
    });

    expect(state.roles).toHaveLength(1);
    expect(state.roles[0]?.length).toBeLessThanOrEqual(1000);
    // Said out loud, because a coworker created on half a brief is one that cannot do the job.
    expect(said).toContain("cut from");
    expect(said).toContain("1000");
  });

  test("bot_add_and_delegate cuts it too, and points the rest at the task", async () => {
    const { state, tools } = fakes();
    const said = await tools.bot_add_and_delegate.execute({
      name: "Eventum Security Bot",
      job: "r".repeat(REPORTED),
      task: "Audit theeventum.com and save the report.",
    });

    expect(state.roles[0]?.length).toBeLessThanOrEqual(1000);
    expect(said).toContain("put anything that fell off the end into the task");
    // The cut does not stop the delegation: the whole point is that the work still gets handed on.
    expect(state.delegations).toHaveLength(1);
  });

  test("a role inside the limit is written whole and nothing is said about a cut", async () => {
    const { state, tools } = fakes();
    const job = "Tests the Eventum website and writes up what it finds.";
    const said = await tools.bot_add.execute({ name: "Auditor", job });

    expect(state.roles[0]).toBe(job);
    expect(said).not.toContain("cut from");
  });

  test("job and instructions are measured together, not one at a time", async () => {
    const { state, tools } = fakes();
    await tools.bot_add.execute({
      name: "Auditor",
      job: "a".repeat(600),
      instructions: "b".repeat(600),
    });

    expect(state.roles[0]?.length).toBeLessThanOrEqual(1000);
  });

  test("bot_update cannot grow a coworker past the limit by appending", async () => {
    const { state, tools } = fakes();
    // The tool that appends is the one that can reach the limit a step at a time, so it is the one
    // that has to be bounded: five "add these instructions" calls used to be five turns of growth.
    for (let i = 0; i < 5; i += 1) {
      await tools.bot_update.execute({
        bot: "Helper",
        instructions: "Extra standing guidance. ".repeat(40),
      });
    }

    for (const role of state.roles) {
      expect(role.length).toBeLessThanOrEqual(1000);
    }
  });

  test("a cut by bot_update says so, rather than reporting a clean edit", async () => {
    const { tools } = fakes();
    const said = await tools.bot_update.execute({
      bot: "Helper",
      job: "r".repeat(REPORTED),
    });

    expect(said).toContain("standing role cut from");
  });

  test("a cut never leaves half a character behind", async () => {
    const { state, tools } = fakes();
    // A family is one character and many code units, so a cut by code unit would end on a dangling
    // joiner and hand that to a model as content.
    await tools.bot_add.execute({
      name: "Auditor",
      job: "👨‍👩‍👧‍👦".repeat(300),
    });

    const role = state.roles[0] ?? "";
    expect(role.length).toBeLessThanOrEqual(1000);
    expect(role.includes("�")).toBe(false);
    for (const { segment } of new Intl.Segmenter(undefined, {
      granularity: "grapheme",
    }).segment(role)) {
      expect(segment).toBe("👨‍👩‍👧‍👦");
    }
  });
});

/*
 * Making the specialist and handing it the work in ONE call.
 *
 * Two tools is two decisions, and a model that has decided to build a specialist has already
 * decided it should do the work: asked to make a Bot and then delegate to it, it can make the Bot,
 * decide the delegation is a separate step, and simply do the job instead. Nothing downstream can
 * repair that, because the transcript shows a successful creation and a confident answer from the
 * wrong Bot. So the two are one tool here, and the model is left with only the outcome to report.
 */
describe("bot_add_and_delegate", () => {
  test("creates the Bot, opens its channel, and hands it the work", async () => {
    const { state, tools } = fakes();
    const said = await tools.bot_add_and_delegate.execute({
      name: "Eventum Security Bot",
      job: "Tests the Eventum website and reports what it finds.",
      task: "Audit theeventum.com and save the findings.",
    });

    const created = state.roster.find(
      (profile) => profile.name === "Eventum Security Bot",
    );
    expect(created).toBeDefined();
    expect(state.channels).toContain(created?.id);
    expect(state.delegations).toEqual([
      { bot: created?.id, task: "Audit theeventum.com and save the findings." },
    ]);
    expect(said).toContain("doing the work in its own channel");
    expect(said).toContain("do not do the work yourself");
  });

  test("the work reaches the specialist, not the Bot that made it", async () => {
    const { state, tools } = fakes();
    await tools.bot_add_and_delegate.execute({
      name: "Eventum Security Bot",
      job: "Tests the Eventum website.",
      task: "Audit theeventum.com.",
    });

    const created = state.roster.find(
      (profile) => profile.name === "Eventum Security Bot",
    );
    expect(state.delegations[0]?.bot).toBe(created?.id);
    expect(state.delegations[0]?.bot).not.toBe(REMII_AGENT_ID);
  });

  test("the created Bot is addressable by its creator without a second grant call", async () => {
    const { state, tools } = fakes();
    await tools.bot_add_and_delegate.execute({
      name: "Eventum Security Bot",
      job: "Tests the Eventum website.",
      task: "Audit theeventum.com.",
    });

    const created = state.roster.find(
      (profile) => profile.name === "Eventum Security Bot",
    );
    expect(state.grants).toContainEqual({
      kind: "bot",
      ref: created?.id,
      agentId: REMII_AGENT_ID,
    });
  });

  test("a handoff that does not land is said out loud, not swallowed", async () => {
    const { tools } = fakes(async () => ({
      ok: false,
      answer: "the channel could not be opened",
    }));
    const said = await tools.bot_add_and_delegate.execute({
      name: "Eventum Security Bot",
      job: "Tests the Eventum website.",
      task: "Audit theeventum.com.",
    });

    expect(said).toContain("did not land");
    expect(said).toContain("not running");
  });

  /*
   * One channel per Bot, not one per step.
   *
   * Making the Bot opens its conversation, and the delegation resolves that same conversation. A
   * plain create in each place leaves the person with an empty channel beside the one holding the
   * work, and the empty one is the one they are likelier to open and conclude the Bot is idle.
   */
  test("the new Bot gets one conversation, not one per step", async () => {
    const { state, tools } = fakes();
    await tools.bot_add_and_delegate.execute({
      name: "Eventum Security Bot",
      job: "Tests the Eventum website.",
      task: "Audit theeventum.com.",
    });

    const created = state.roster.find(
      (profile) => profile.name === "Eventum Security Bot",
    );
    const mentions = state.channels.filter((id) => id === created?.id).length;
    expect(mentions).toBe(1);
  });

  test("needs a name, a job, and the task", async () => {
    const { tools } = fakes();
    const said = await tools.bot_add_and_delegate.execute({
      name: "Eventum Security Bot",
    });

    expect(said).toContain("needs a name, a job description, and the task");
  });

  test("the report requirement travels with the task", async () => {
    let seen: { constraints?: string; expecting?: string } | undefined;
    const { tools } = fakes(async (input) => {
      seen = input;
      return { ok: true, answer: "sent" };
    });
    await tools.bot_add_and_delegate.execute({
      name: "Eventum Security Bot",
      job: "Tests the Eventum website.",
      task: "Audit theeventum.com.",
      constraints: "black box, non destructive",
      expecting: "a saved report",
    });

    expect(seen?.constraints).toBe("black box, non destructive");
    expect(seen?.expecting).toBe("a saved report");
  });
});

describe("bot_summon", () => {
  test("copies a template and opens its channel", async () => {
    const { state, tools } = fakes();
    const said = await tools.bot_summon.execute({ template: "Research Desk" });

    expect(said).toContain("now in the workspace");
    expect(state.roster.some((profile) => profile.id === "copy-of-tpl-1")).toBe(
      true,
    );
    expect(state.channels).toContain("copy-of-tpl-1");
    expect(state.audit.some((row) => row.eventType === "bot.duplicated")).toBe(
      true,
    );
  });

  test("refuses a Bot that is already in the workspace", async () => {
    const { tools } = fakes();
    const said = await tools.bot_summon.execute({ template: "Helper" });

    expect(said).toContain("already in the workspace");
  });

  test("names the roster when nothing matches", async () => {
    const { tools } = fakes();
    const said = await tools.bot_summon.execute({ template: "Nobody" });

    expect(said).toContain("no such Bot");
    expect(said).toContain("Research Desk");
  });
});

describe("bot_add and bot_delete", () => {
  test("adds with a name and a job, and opens its channel", async () => {
    const { state, tools } = fakes();
    const said = await tools.bot_add.execute({
      name: "Scribe",
      job: "Takes notes.",
    });

    expect(said).toContain("is ready");
    expect(state.channels.length).toBe(1);
  });

  /*
   * Making a Bot and being able to hand work to it are one step.
   *
   * Without this the run makes the Bot, is then refused permission to delegate to it, and does the
   * work itself — which is exactly the empty-Bot-there-is-nothing-here report this fixes. The grant
   * is the one `bot_grant` writes for a handoff, so a Bot made here is as addressable as one a
   * person granted by hand.
   */
  test("lets the Bot that made it delegate to it, without a second tool call", async () => {
    const { state, tools } = fakes();
    await tools.bot_add.execute({ name: "Scribe", job: "Takes notes." });

    const created = state.roster.find((profile) => profile.name === "Scribe");
    expect(created).toBeDefined();
    expect(state.grants).toContainEqual({
      kind: "bot",
      ref: created?.id,
      agentId: REMII_AGENT_ID,
    });
  });

  test("summoning a template also makes it addressable by the summoning Bot", async () => {
    const { state, tools } = fakes();
    await tools.bot_summon.execute({ template: "Research Desk" });

    expect(state.grants).toContainEqual({
      kind: "bot",
      ref: "copy-of-tpl-1",
      agentId: REMII_AGENT_ID,
    });
  });

  test("add needs both halves", async () => {
    const { tools } = fakes();
    const said = await tools.bot_add.execute({ name: "Scribe" });

    expect(said).toContain("needs a name and a job");
  });

  test("deletes a workspace copy", async () => {
    const { tools } = fakes();
    const said = await tools.bot_delete.execute({ bot: "Helper" });

    expect(said).toContain("is gone");
  });

  test("never deletes a shared template", async () => {
    const { tools } = fakes();
    const said = await tools.bot_delete.execute({ bot: "Research Desk" });

    expect(said).toContain("cannot be deleted");
  });
});

describe("bot_grant and bot_revoke", () => {
  test("grants a skill and records it", async () => {
    const { state, tools } = fakes();
    const said = await tools.bot_grant.execute({
      bot: "Helper",
      kind: "skill",
      ref: "bot-creator",
    });

    expect(said).toContain("now holds");
    expect(state.grants).toContainEqual({
      kind: "skill",
      ref: "bot-creator",
      agentId: "bot-1",
    });
  });

  test("an app tool grant uses the mcp kind", async () => {
    const { state, tools } = fakes();
    await tools.bot_grant.execute({
      bot: "Helper",
      kind: "tool",
      ref: "composio-gmail/GMAIL_SEND",
    });

    expect(state.grants).toContainEqual({
      kind: "mcp",
      ref: "composio-gmail/GMAIL_SEND",
      agentId: "bot-1",
    });
  });

  test("revokes what was granted", async () => {
    const { state, tools } = fakes();
    await tools.bot_grant.execute({ bot: "Helper", kind: "skill", ref: "x" });
    const said = await tools.bot_revoke.execute({
      bot: "Helper",
      kind: "skill",
      ref: "x",
    });

    expect(said).toContain("no longer holds");
    expect(state.grants).toHaveLength(0);
  });

  test("a handoff grant resolves the target by name", async () => {
    const { state, tools } = fakes();
    await tools.bot_grant.execute({
      bot: "Helper",
      kind: "handoff",
      ref: "Research Desk",
    });

    expect(state.grants).toContainEqual({
      kind: "bot",
      ref: "tpl-1",
      agentId: "bot-1",
    });
  });
});

describe("update_settings", () => {
  test("changes execution mode and instructions together", async () => {
    const { state, tools } = fakes();
    const said = await tools.update_settings.execute({
      execution_mode: "ask-first",
      standing_instructions: "Write briefly.",
    });

    expect(said).toContain("ask-first");
    expect(state.settings).toBeDefined();
  });

  test("asks what to change when given nothing", async () => {
    const { tools } = fakes();
    const said = await tools.update_settings.execute({});

    expect(said).toContain("Say what to change");
  });
});

describe("connections", () => {
  test("lists held and brokered accounts by app", async () => {
    const { tools } = fakes();
    const said = await tools.connection_list.execute({});

    expect(said).toContain("drive");
    expect(said).toContain("gmail");
    expect(said).toContain("conn-1");
  });

  test("revokes by app name", async () => {
    const { tools } = fakes();
    const said = await tools.connection_revoke.execute({ connection: "gmail" });

    expect(said).toContain("Disconnected gmail");
  });

  test("names what is connected when nothing matches", async () => {
    const { tools } = fakes();
    const said = await tools.connection_revoke.execute({ connection: "fax" });

    expect(said).toContain("No connected account matches");
  });
});

describe("bot_update", () => {
  test("updates an existing workspace coworker", async () => {
    const { state, tools } = fakes();
    const said = await tools.bot_update.execute({
      bot: "Helper",
      name: "Senior Helper",
      title: "Lead Assistant",
      job: "Lead workspace assistant.",
      instructions: "Always verify details first.",
    });

    expect(said).toContain("Updated Senior Helper");
    const updated = state.roster.find((b) => b.id === "bot-1");
    expect(updated?.name).toBe("Senior Helper");
    expect(updated?.title).toBe("Lead Assistant");
    expect(updated?.roleDescription).toContain("Lead workspace assistant.");
    expect(updated?.roleDescription).toContain("Always verify details first.");
    expect(state.audit.some((row) => row.eventType === "bot.updated")).toBe(
      true,
    );
  });

  test("refuses to update a system template", async () => {
    const { tools } = fakes();
    const said = await tools.bot_update.execute({
      bot: "Research Desk",
      name: "New Research Desk",
    });

    expect(said).toContain("is a shared template");
  });
});

describe("bot_read and bot_list", () => {
  test("bot_read inspects coworker details", async () => {
    const { tools } = fakes();
    const said = await tools.bot_read.execute({ bot: "Helper" });

    expect(said).toContain("Coworker: Helper");
    expect(said).toContain("Title: Helper title");
    expect(said).toContain("Handoff targets: bot-1");
  });

  test("bot_list lists coworkers and templates", async () => {
    const { tools } = fakes();
    const said = await tools.bot_list.execute({});

    expect(said).toContain("Workspace Coworkers:");
    expect(said).toContain("Helper");
    expect(said).toContain("Available Templates");
    expect(said).toContain("Research Desk");
  });
});

describe("coworker_status", () => {
  test("checks status of a specific coworker", async () => {
    const { tools } = fakes();
    const said = await tools.coworker_status.execute({ bot: "Helper" });

    expect(said).toContain("Coworker: Helper");
    expect(said).toContain("Status: Idle");
    expect(said).toContain("Analyzing Q3 reports");
    expect(said).toContain("Finished reviewing the revenue numbers.");
    expect(said).toContain("Recent exchange:");
  });

  test("checks status of all coworkers", async () => {
    const { tools } = fakes();
    const said = await tools.coworker_status.execute({ bot: "all" });

    expect(said).toContain("Workspace Coworkers Status:");
    expect(said).toContain("Helper");
  });
});

describe("app permissions grant and revoke", () => {
  test("grants an app by app name", async () => {
    const { state, tools } = fakes();
    const said = await tools.bot_grant.execute({
      bot: "Helper",
      kind: "app",
      ref: "gmail",
    });

    expect(said).toContain("now holds that app");
    expect(
      state.grants.some((g) => g.kind === "account" && g.ref === "conn-1"),
    ).toBe(true);
    expect(
      state.grants.some(
        (g) => g.kind === "server" && g.ref === "composio-gmail",
      ),
    ).toBe(true);
  });

  test("revokes an app by app name", async () => {
    const { state, tools } = fakes();
    await tools.bot_grant.execute({ bot: "Helper", kind: "app", ref: "gmail" });
    const said = await tools.bot_revoke.execute({
      bot: "Helper",
      kind: "app",
      ref: "gmail",
    });

    expect(said).toContain("no longer holds that app");
    expect(
      state.grants.some((g) => g.kind === "account" && g.ref === "conn-1"),
    ).toBe(false);
  });
});

describe("update_settings action policy", () => {
  test("updates action policy", async () => {
    const { state, tools } = fakes();
    const said = await tools.update_settings.execute({
      action_policy: 'intent == "type" && contains(element.name, "password")',
    });

    expect(said).toContain("browser action policy updated");
    expect(state.settings.actionPolicy).toBe(
      'intent == "type" && contains(element.name, "password")',
    );
  });
});
