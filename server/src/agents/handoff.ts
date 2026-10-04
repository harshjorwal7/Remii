/**
 * One Bot handing work to another.
 *
 * A person can put several Bots in a channel and address them with `@`. What they could not do is
 * let one Bot bring in another: every hop went through a person, who read the answer, decided who
 * should see it next, and pasted it across.
 *
 * THIS IS THE PART THAT DECIDES, not the part that delivers. It resolves who is being addressed,
 * refuses when it should, writes the row that says what happened, and puts a durable hop on the
 * queue. What claims that hop and runs the other Bot is `handoff-runner.ts`, and the split is
 * deliberate: deciding happens inside somebody's run and must be fast and fail closed, while
 * delivering is a whole agent turn that has to survive the pod it started on.
 *
 * EVERY REFUSAL IS AN ANSWER, NOT AN ERROR. The asking Bot is mid-run with a person waiting, so a
 * refusal comes back as a sentence it can say. A thrown error ends the run with nothing said, which
 * reads to the person as the Bot ignoring them.
 */
import { createHash } from "node:crypto";
import { type AuditStore, recordAuditEvent } from "../audit";
import type { WorkQueue } from "../work/queue";
import type { RunAssertion } from "./callback-token";
import type { AgentProfileStore } from "./profile-store";
import type { AgentActor } from "./profile-types";

/** The kind of work a hop is, on the shared queue. */
export const HANDOFF_KIND = "bot.message";

/** The kind of grant that lets one Bot address another. */
export const HANDOFF_GRANT = "bot";

/**
 * What one Bot sends another.
 *
 * TYPED FIELDS, NOT A PARAGRAPH, and this is the one decision here taken against the obvious build.
 * The natural shape is `message_bot(target, message)` and it is what the issue proposed. Free text is
 * the commonest way a multi-agent system goes quietly wrong: the receiving Bot has to infer the
 * intent, re-derive the constraints and guess what shape of answer was wanted, and when it guesses
 * wrong it does not fail, it confidently returns something else. Naming the parts costs the asking
 * model a little more effort and removes most of that.
 */
export type HandoffEnvelope = {
  /** What the other Bot is being asked to do. */
  task: string;
  /** Anything that bounds it: a date range, a system, a rule it must not break. */
  constraints?: string;
  /** What good looks like coming back: a list, a number, a recommendation with reasons. */
  expecting?: string;
};

/** How far this may go, in numbers a deployment chooses rather than constants. */
export type HandoffCaps = {
  /** How many Bots deep a chain may go. Zero means one Bot may never address another. */
  maxDepth: number;
  /** How many other Bots one run may address. */
  maxPerRun: number;
};

export type HandoffOutcome =
  | {
      ok: true;
      to: string;
      toName: string;
      inOwnChannel?: boolean;
      channelId?: string;
    }
  | { ok: false; refusal: string };

export type HandoffDesk = {
  send: (input: {
    /**
     * The run doing the asking, as this deployment signed it.
     *
     * Where the answer goes comes from here too. A Bot naming its own thread would be a Bot able to
     * drop a turn into a conversation it was never part of.
     */
    from: RunAssertion;
    /** The Bot being addressed, as the model named it. */
    target: string;
    envelope: HandoffEnvelope;
    /**
     * Run the work in the target Bot's own conversation with this person, rather than in a scratch
     * thread whose only output is relayed back to the Bot that asked.
     */
    runInOwnChannel?: boolean;
  }) => Promise<HandoffOutcome>;
};

export function createHandoffDesk(options: {
  queue: WorkQueue;
  profiles: AgentProfileStore;
  /** Whether the asking Bot has been granted the Bot it is addressing. Read per hop, never cached. */
  mayAddress: (fromBotId: string, toBotId: string) => Promise<boolean>;
  /**
   * Who the person is, as the roster is decided for them. Null when that cannot be established.
   *
   * A seam rather than a hardcoded `role: "user"`, because an administrator sees Bots a user does
   * not: assumed, an administrator's hop to a Bot they can see and chat with was refused as "no
   * such Bot". Resolved per hop, so a role granted or taken away a minute ago counts.
   *
   * NULL RATHER THAN A THROW, because everything in this module answers with a sentence. A role
   * revoked mid-run, or a database that blinked, would otherwise end the run with nothing said at
   * all — the failure the file's own opening paragraph is about, arriving through a seam added to
   * fix something else. `mayAddress` beside it catches for exactly this reason.
   */
  actorFor: (userId: string) => Promise<AgentActor | null>;
  /**
   * The conversation this person already has with the target Bot, made if they have not had one.
   *
   * Resolved here rather than named by the model, so a hop can only ever land in a channel the
   * person and that Bot already share.
   *
   * BOTH IDS, AND NAMED, because a channel and its thread are two different things and a bare
   * `Promise<string>` cannot say which one it returned. This seam returned a channel id while every
   * caller treated the value as a thread id, and the whole delegation was invisible to the person
   * as a result — so the return type now makes the question unaskable. See `ownThreadFor` in
   * `index.ts` for what that looked like in the database.
   */
  ownThreadFor?: (
    actorId: string,
    botId: string,
  ) => Promise<{ channelId: string; threadId: string } | null>;
  /**
   * The channel a thread belongs to, or null for a thread that is not one anybody opens.
   *
   * A second seam beside `ownThreadFor` and not folded into it, because the two answer opposite
   * questions: this goes from a conversation to the row a roster is made of, and the other goes from
   * a coworker to the conversation they share with a person.
   */
  channelIdForThread?: (threadId: string) => Promise<string | null>;
  /**
   * Told that a hop was accepted, so the asking run can be shown as waiting rather than working.
   *
   * A SEPARATE SEAM FROM `refuse`, and not a return value, for the reason every side effect here is
   * one: the caller is a tool executing inside a run, and a hop that has been accepted must not be
   * un-accepted because a working indicator could not be lit. Never awaited.
   *
   * Called on ACCEPTANCE ONLY. A refused hop leaves the asking run doing whatever it does next,
   * which is the honest state — the work was not handed over, so nothing is waiting on a coworker.
   */
  onDelegated?: (input: {
    /** The run that asked, so the row to move is named rather than guessed at. */
    fromRunId: string;
    fromBotId: string;
    toBotId: string;
    toName: string;
    actorId: string;
    /**
     * Where the work lands, when it lands in the target's own channel. Absent for a hop into a
     * scratch thread, whose output comes back by relay instead.
     */
    ownChannel?: { channelId: string; threadId: string } | null;
    /**
     * The conversation that ASKED, resolved to a channel.
     *
     * A run's own thread cannot be relied on to say this — a chat turn's thread is whatever the
     * browser sent, and a hop's is a scratch thread — so the desk resolves it while it still holds
     * the asking Bot and the person, and hands over a channel id. Absent when nothing matched, which
     * is a run with no channel rather than a wrong one.
     */
    askingChannelId?: string | null;
  }) => void;
  auditStore: AuditStore;
  caps: HandoffCaps;
}): HandoffDesk {
  const {
    queue,
    profiles,
    mayAddress,
    actorFor,
    ownThreadFor,
    channelIdForThread,
    onDelegated,
    auditStore,
    caps,
  } = options;

  /** Said once, so the trail carries the same words the Bot was given. */
  async function refuse(
    from: RunAssertion,
    target: string,
    reason: string,
    refusal: string,
  ): Promise<HandoffOutcome> {
    await recordAuditEvent(auditStore, {
      eventType: "agent.handoff_refused",
      targetType: "agent",
      targetId: from.botId,
      ...(from.actorId ? { actorUserId: from.actorId } : {}),
      ...(from.initiator ? { initiator: from.initiator } : {}),
      payload: {
        // The same key `agent.handoff_offered` sets below, and for the same reason: the Audit
        // screen renders `payload.bot` and nothing else in its Bot column, so a row without it
        // shows a dash. The accepted row was given this and its refusal was not, which left the
        // refusal — the one the trail says matters more, because a hop that happened is visible in
        // the transcript and a refused one is invisible everywhere else — naming no Bot at all.
        bot: from.botId,
        from: from.botId,
        // As the model named it, capped: untrusted input, kept because "who did it reach for" is the
        // useful half of the question.
        target: target.slice(0, 120),
        run: from.runId,
        depth: from.depth ?? 0,
        reason,
      },
    });
    return { ok: false, refusal };
  }

  return {
    async send({ from, target, envelope, runInOwnChannel }) {
      const task = envelope.task?.trim() ?? "";
      if (!task) {
        return refuse(
          from,
          target,
          "no_task",
          "Nothing was sent: a handoff has to say what the other Bot is being asked to do.",
        );
      }

      if (!from.threadId) {
        return refuse(
          from,
          target,
          "no_thread",
          "This run is not in a conversation, so there is nowhere for another Bot's answer to land.",
        );
      }

      /*
       * The depth cap first, because it is the one that stops a loop.
       *
       * A asks B asks C asks A is the obvious failure and it spends real money going round. The count
       * arrives in the signed assertion, so it is the deployment's number rather than anything the
       * model can edit, and it is already correct on whichever pod this run landed on.
       */
      const depth = from.depth ?? 0;
      if (depth >= caps.maxDepth) {
        return refuse(
          from,
          target,
          "depth_cap",
          caps.maxDepth === 0
            ? "This deployment does not let one Bot hand work to another."
            : `This is already ${depth} ${depth === 1 ? "Bot" : "Bots"} deep, which is as far as this deployment allows. Answer with what you have, or ask the person.`,
        );
      }

      /*
       * The fan-out cap is enforced by the offer below rather than checked here.
       *
       * Checking first and offering second is a cap that holds only while nothing else is offering,
       * and the case it has to hold in is precisely the opposite one: a model asked to do several
       * things emits several tool calls in one turn, they run at once, and each reads a count taken
       * before any of the others had written. Five calls passed a cap of three, every time, on a
       * single pod. So the count and the write are one step, in the queue. See `atMost`.
       */

      /*
       * Resolved against the roster the ASKING PERSON may see, never taken from the model.
       *
       * A Bot must not be able to reach a Bot its person cannot, or this becomes a way around agent
       * visibility: the model would name anything and the deployment would go and find it.
       *
       * THE ROLE IS ASKED FOR, NOT ASSUMED. Which coworkers exist is decided per person, and an
       * administrator sees Bots a user does not. Hardcoded to `user`, an administrator's own hop to
       * a Bot they can see and chat with in the UI was refused as "no such Bot" — the same failure
       * `index.ts` warns about for a routine's owner, one file over.
       */
      const actor = await actorFor(from.actorId);
      if (!actor) {
        return refuse(
          from,
          target,
          "no_actor",
          "Who you are asking on behalf of could not be confirmed just now, so this was not sent. Try again, or ask the person.",
        );
      }
      const roster = await profiles.list(actor);
      const wanted = target.trim().toLowerCase();
      /*
       * An id is exact and a name is not, so an id wins outright.
       *
       * `agents.name` has no unique constraint and duplicating a Bot deliberately makes a second one
       * with the same name, so a person can be looking at two Bots called Knowledge. Taking whichever
       * sorted first would send the work to a Bot nobody meant — and the grant check runs after this,
       * so with only the other twin granted a perfectly legitimate hop is refused as "not granted".
       * Neither failure says a word about there having been two.
       */
      const byId = roster.find(
        (candidate) => candidate.id.toLowerCase() === wanted,
      );
      const byName = roster.filter(
        (candidate) => candidate.name.toLowerCase() === wanted,
      );
      /*
       * A template is a definition, not a coworker, and it is not something
       * work can be handed to.
       *
       * Summoning is the act that turns one into a Bot that answers, and it is
       * the only act. Left in this list, a template both answers to its name
       * and makes that name ambiguous against the summoned copy beside it — so
       * a workspace that summoned "Research Desk" from the template of that
       * name could never hand work to either of them by name, and the refusal
       * it got back for it would be `ambiguous_bot` naming two ids and
       * explaining nothing about either.
       *
       * Templates are on the roster this person can already see, so naming one
       * here discloses nothing the roster did not — which is why this is a
       * clearer sentence than the flat "no such Bot" below deliberately is.
       */
      const isTemplate = (candidate: (typeof byName)[number]) =>
        candidate.isSystemTemplate === true;
      // Hidden and deleted are filtered here for the same reason they were
      // before: the ambiguity check below must count exactly what the fallback
      // below would pick from, or the two disagree about whether there was ever
      // a choice to make.
      const reachable = byName.filter(
        (candidate) =>
          !candidate.hidden &&
          candidate.deletedAt === null &&
          !isTemplate(candidate),
      );
      const namedButOnlyTemplates =
        byName.length > 0 &&
        reachable.length === 0 &&
        byName.some((candidate) => !candidate.hidden && isTemplate(candidate));
      if (namedButOnlyTemplates || (byId && isTemplate(byId))) {
        return refuse(
          from,
          target,
          "not_a_coworker",
          `"${target.trim().slice(0, 60)}" is a shared template rather than a coworker, so it cannot be given work. Summon it into the workspace first, then hand the work to the copy.`,
        );
      }
      if (!byId && reachable.length > 1) {
        /*
         * Named rather than guessed at. The ids are the escape hatch this refusal is pointing at,
         * and they are all Bots this person can already see, so naming them tells the model nothing
         * the roster did not.
         */
        return refuse(
          from,
          target,
          "ambiguous_bot",
          `More than one Bot is called "${target.trim().slice(0, 60)}": ${reachable
            .map((candidate) => candidate.id)
            .join(", ")}. Ask again using the one you mean.`,
        );
      }
      // `reachable`, not `byName`: the same list the ambiguity check one line above counted. The
      // roster already filters hidden and deleted today, so these agree — but a fallback that could
      // disagree with the check guarding it is one refactor away from being wrong.
      const found = byId ?? reachable[0];

      /*
       * The same answer whether it does not exist or is not theirs to see.
       *
       * Two different sentences here would let a Bot enumerate the deployment's roster by asking for
       * names and reading which refusal came back.
       */
      if (!found || found.hidden || found.deletedAt !== null) {
        return refuse(
          from,
          target,
          "no_such_bot",
          `There is no Bot called "${target.trim().slice(0, 60)}" that you can reach.`,
        );
      }

      if (found.id === from.botId) {
        return refuse(
          from,
          target,
          "self",
          "A Bot cannot hand work to itself. Do it, or ask the person.",
        );
      }

      /*
       * A paused coworker is held, not deleted.
       *
       * Checked here, at the desk, rather than only where a run would start, because this is the
       * only point where the asking Bot is still talking and can be told. The alternative — accepting
       * the hop and refusing it at delivery — spends a queue hop, a run row and a lock on work that
       * was never going to happen, and answers the person with silence where a sentence would do.
       *
       * Refused rather than queued, deliberately. A queue would be simpler to the person and wrong
       * for them: a pause usually means "stop doing this kind of thing", and everything queued
       * during it is work they no longer want, firing all at once when the pause lifts.
       */
      if (found.pausedAt) {
        return refuse(
          from,
          target,
          "bot_paused",
          `${found.name} is paused${
            found.pausedReason ? ` — ${found.pausedReason}` : ""
          } — so it will not be given work. Do the work yourself, or ask the person to resume it.`,
        );
      }

      // Read per hop and never held, so revoking a grant applies to the next hop rather than after a
      // restart.
      if (!(await mayAddress(from.botId, found.id))) {
        return refuse(
          from,
          target,
          "not_granted",
          `You have not been given ${found.name} to hand work to.`,
        );
      }

      /*
       * The Bot's own conversation, when the caller asked for the work to happen there rather than
       * in a scratch thread whose only output is relayed back.
       *
       * RESOLVED HERE, NEVER NAMED BY THE MODEL. A thread id in a tool argument is a Bot choosing
       * where its own work runs, which is the same authority as choosing whose conversation it
       * speaks in. This resolves the one conversation this person and that Bot already share, and
       * makes it if they have not had one, so a hop into an own channel always lands somewhere the
       * person can actually open and read.
       */
      let ownChannel: { channelId: string; threadId: string } | null = null;
      if (runInOwnChannel) {
        if (!ownThreadFor) {
          return refuse(
            from,
            target,
            "no_own_channel",
            `${found.name} has nowhere of its own to work in right now. Do the work yourself, or ask the person.`,
          );
        }
        try {
          ownChannel = await ownThreadFor(from.actorId, found.id);
        } catch {
          ownChannel = null;
        }
        if (!ownChannel) {
          return refuse(
            from,
            target,
            "no_own_channel",
            `${found.name}'s own channel could not be opened, so the work was not delegated. Do it yourself, or ask the person.`,
          );
        }
      }

      /*
       * The key is what stops this happening twice.
       *
       * `offer` is idempotent on it, and that is the only thing between a retried delivery and a
       * second run of the receiving Bot. So it is derived from the run and the contents of the
       * envelope rather than from a fresh id: the same request, sent twice in one run, is one hop.
       * That is the honest reading of a model repeating itself, and the alternative is at-least-once
       * with no ceiling.
       *
       * THE RUN IS HASHED, NOT INTERPOLATED, because `runId` arrives on the request and is a plain
       * string this deployment never constrains. Written in raw it decides both halves of the key:
       * a run calling itself `notice` gave the fan-out prefix `notice:`, which is what every failure
       * notice in the deployment is keyed under, so one turn's budget of three was spent by other
       * people's dead hops. Hashing removes every character a caller chooses from the prefix while
       * keeping it stable for the run, which is all the cap needs.
       */
      const runPrefix = `hop:${createHash("sha256")
        .update(`${from.actorId}\u0000${from.runId}`)
        .digest("hex")
        .slice(0, 32)}:`;
      const key = `${runPrefix}${createHash("sha256")
        .update(
          JSON.stringify([
            found.id,
            task,
            envelope.constraints ?? "",
            envelope.expecting ?? "",
          ]),
        )
        .digest("hex")
        .slice(0, 32)}`;

      const offered = await queue.offer({
        kind: HANDOFF_KIND,
        key,
        /*
         * Counted from the rows rather than from a variable, because a run whose hops land on
         * several pods is exactly what this exists to bound: every hop this run has offered is a row
         * under its own prefix, so the rows are the count.
         */
        atMost: { keyPrefix: runPrefix, max: caps.maxPerRun },
        payload: {
          fromBotId: from.botId,
          toBotId: found.id,
          actorId: from.actorId,
          threadId: from.threadId,
          runId: from.runId,
          /*
           * One deeper than the run that asked. The receiving Bot's own assertion is minted from
           * this, so the cap keeps counting across every pod the chain touches.
           */
          depth: depth + 1,
          ...(from.initiator ? { initiator: from.initiator } : {}),
          /*
           * Set ONLY when the caller asked for the work to run in the target Bot's own channel.
           *
           * `answerIn` alone means two different things to the delivery — "run here" and "this is a
           * relay coming home" — and a delegation into a specialist's own channel is the first without
           * being the second. So the second is named rather than inferred from the first.
           */
          /*
           * The THREAD the work runs in, and the CHANNEL a person opens to read it, as two fields.
           *
           * They were one field for as long as this existed, and one field could only be one of
           * them: `answerIn` is what the delivery runs the hop in, and the delivery needs a thread.
           * Passing the channel there produced a phantom thread named after a channel, and the
           * coworker's real conversation stayed empty.
           */
          ...(ownChannel
            ? {
                answerIn: ownChannel.threadId,
                ownChannel: true,
                ownChannelId: ownChannel.channelId,
              }
            : {}),
          /*
           * The asking Bot's display name, resolved here against the same roster the target was.
           *
           * The delivery writes one line of this into the addressed Bot's conversation, and a person
           * reading it should see "Remii" rather than `general-assistant`. Resolved on
           * this side because this is the side holding the roster; the delivery runs minutes later
           * on another replica and would have to fetch it again.
           */
          ...(roster.find((profile) => profile.id === from.botId)?.name
            ? {
                fromName: roster.find((profile) => profile.id === from.botId)
                  ?.name,
              }
            : {}),
          toName: found.name,
          task,
          ...(envelope.constraints
            ? { constraints: envelope.constraints }
            : {}),
          ...(envelope.expecting ? { expecting: envelope.expecting } : {}),
        },
      });

      if (offered === "refused") {
        return refuse(
          from,
          target,
          "fanout_cap",
          `This turn has already asked ${caps.maxPerRun} ${caps.maxPerRun === 1 ? "Bot" : "Bots"}, which is as many as this deployment allows. Answer with what you have, or ask the person.`,
        );
      }

      /*
       * The same ask again, which is not a second ask.
       *
       * `offer` is idempotent on the key, so a model repeating itself inside one run leaves one hop
       * — which is the intent. What must not happen is telling it "handed over" a second time: the
       * row it names may already have been delivered and finished, in which case nothing is queued
       * and nobody is going to run it, and the Bot has just promised the person an answer twice. Said
       * plainly instead, and not audited as a new hop, because it is not one.
       */
      if (offered === "already") {
        /*
         * Recorded like every other refusal, and worded without claiming when.
         *
         * "In this turn" was a guess: the key is per run, and the run id arrives on the request, so
         * a caller reusing one makes that sentence false. What is certainly true is that this exact
         * ask already exists — it may be queued, it may have been delivered and finished. Either
         * way it is not a new hop and saying "handed over" would promise a second answer.
         */
        return refuse(
          from,
          target,
          "duplicate",
          `You have already asked ${found.name} exactly this. Wait for that answer rather than asking again.`,
        );
      }

      await recordAuditEvent(auditStore, {
        eventType: "agent.handoff_offered",
        targetType: "agent",
        targetId: found.id,
        ...(from.actorId ? { actorUserId: from.actorId } : {}),
        ...(from.initiator ? { initiator: from.initiator } : {}),
        payload: {
          // The Bot that did this, under the key the Audit screen reads for its Bot column. `from`
          // below says the same thing and is what the payload is read by, but the screen renders
          // `payload.bot` and nothing else, so without this the two handoff rows are the only Bot
          // actions on a screen headed "Every action a Bot took" that name no Bot.
          bot: from.botId,
          from: from.botId,
          to: found.id,
          run: from.runId,
          depth: depth + 1,
          // What was asked, so the trail says what one Bot sent another rather than merely that it
          // did. The task is the Bot's own words about the work, not a person's private content.
          task: task.slice(0, 500),
        },
      });

      /*
       * Accepted, so the asking run is now waiting on somebody. Told here rather than by the caller
       * polling, because the caller is a tool inside a run and has no way to know the desk accepted
       * anything until it reads the tool's own return value — by which time the hop may already be
       * running somewhere else.
       */
      try {
        onDelegated?.({
          fromRunId: from.runId,
          fromBotId: from.botId,
          toBotId: found.id,
          toName: found.name,
          actorId: from.actorId,
          /*
           * The CHANNEL the work lands in, which the run that asked has no way to work out: it is
           * the target's conversation, and the asker is not a member of it. Passed whole so the
           * activity row can name a channel rather than only a Bot.
           */
          ownChannel,
          /*
           * And the one that ASKED, resolved here because this is the last moment that holds the
           * asking conversation and the person who owns it together.
           */
          askingChannelId: channelIdForThread
            ? await channelIdForThread(from.threadId).catch(() => null)
            : null,
        });
      } catch {
        // A side effect. The hop is queued either way.
      }

      return {
        ok: true,
        to: found.id,
        toName: found.name,
        /*
         * `channelId` IS THE CHANNEL'S ID, or it is not reported at all.
         *
         * It used to carry the thread id under a channel id's name, which is a field nothing read
         * and that a future reader would have believed. A tool's return value is read by a model,
         * so a field that looks like an id and is the wrong kind of id is worse than no field.
         */
        ...(ownChannel
          ? { inOwnChannel: true, channelId: ownChannel.channelId }
          : {}),
      };
    },
  };
}
