import { describe, expect, test } from "bun:test";
import type {
  AgentSubscriber,
  BaseEvent,
  Message,
  RunAgentResult,
} from "@ag-ui/client";
import { AbstractAgent, EventType } from "@ag-ui/client";
import { Observable } from "rxjs";
import { ABANDONED_RUN_GRACE_MS } from "../src/activity/abandoned";
import {
  EnforcedAgent,
  LoopBreakerLimitError,
  TURN_HEARTBEAT_MS,
} from "../src/billing/metering";
import { createTurnRunner } from "../src/routines/run-turn";
import { FATIGUE_LIMIT } from "../src/routines/runner";

/**
 * Metering is enforced, not merely computed.
 *
 * `verifyTurnEligibility`, `calculateTurnCredits` and `deductTurnCredits`
 * are pure credit math; what matters is that a turn cannot run without them:
 * the enforced agent breaks runaway loops on both run paths, settles usage
 * exactly once, and the routine runner reports real spend so the daily
 * circuit breaker counts credits rather than firings.
 */

const toolStart = (id: string): BaseEvent =>
  ({ type: EventType.TOOL_CALL_START, toolCallId: id }) as BaseEvent;

const finishedWithUsage = (prompt: number, completion: number): BaseEvent =>
  ({
    type: EventType.RUN_FINISHED,
    usage: { promptTokens: prompt, completionTokens: completion },
  }) as BaseEvent;

/** An inner agent driven entirely by a scripted event list. */
class ScriptedAgent extends AbstractAgent {
  aborts = 0;
  constructor(
    public script: BaseEvent[] = [],
    agentId = "bot_test",
  ) {
    super({ agentId, description: "scripted" });
  }

  override run(): Observable<BaseEvent> {
    return new Observable((observer) => {
      for (const event of this.script) observer.next(event);
      observer.complete();
    });
  }

  override async runAgent(): Promise<RunAgentResult> {
    const input = {
      threadId: this.threadId,
      runId: "run_test",
      messages: this.messages,
    };
    for (const subscriber of [...this.subscribers]) {
      for (const event of this.script) {
        await subscriber.onEvent?.({
          event,
          messages: this.messages,
          state: this.state,
          agent: this,
          input: input as never,
        });
      }
      await subscriber.onRunFinalized?.({
        messages: this.messages,
        state: this.state,
        agent: this,
        input: input as never,
      });
    }
    return { result: "done" } as RunAgentResult;
  }

  override abortRun(): void {
    this.aborts += 1;
    super.abortRun();
  }
}

describe("EnforcedAgent", () => {
  test("settles usage exactly once on the runAgent path", async () => {
    const inner = new ScriptedAgent([
      toolStart("c1"),
      finishedWithUsage(12_000, 3_000),
    ]);
    const settled: unknown[] = [];
    const enforced = new EnforcedAgent(inner, {
      onTurnSettled: (params) => {
        settled.push(params);
      },
    });
    await enforced.runAgent();
    expect(settled).toHaveLength(1);
    const first = settled[0] as Record<string, number>;
    expect(first.promptTokens).toBe(12_000);
    expect(first.completionTokens).toBe(3_000);
  });

  test("breaks a runaway loop past 100 tool calls and aborts", async () => {
    const inner = new ScriptedAgent(
      Array.from({ length: 101 }, (_, index) => toolStart(`c${index}`)),
    );
    const settled: unknown[] = [];
    const enforced = new EnforcedAgent(inner, {
      onTurnSettled: (params) => {
        settled.push(params);
      },
    });
    await expect(enforced.runAgent()).rejects.toBeInstanceOf(
      LoopBreakerLimitError,
    );
    expect(inner.aborts).toBeGreaterThanOrEqual(1);
    expect(settled).toHaveLength(1);
  });

  test("the run path still meters and settles", async () => {
    const inner = new ScriptedAgent([finishedWithUsage(500, 100)]);
    const settled: unknown[] = [];
    const enforced = new EnforcedAgent(inner, {
      onTurnSettled: (params) => {
        settled.push(params);
      },
    });
    await new Promise<void>((resolve, reject) => {
      enforced
        .run({
          threadId: "t",
          runId: "r",
          messages: [] as Message[],
        } as never)
        .subscribe({ next: () => undefined, error: reject, complete: resolve });
    });
    expect(settled).toHaveLength(1);
  });
});

/*
 * A RUN THAT WAS RECORDED AND NEVER CLOSED.
 *
 * `beforeRun` is what calls `runActivityStore.begin`, so by the time it resolves the run has a row
 * and the roster is drawing a working pulse for it. On the SSE path the subscription can be torn
 * down while that same `beforeRun` is still outstanding — the response aborts on `request.signal`
 * and unsubscribes, which is what a closed tab, a refresh and a dropped connection each look like
 * from the runtime — and the teardown had no way to settle a turn whose meter it had not built yet.
 *
 * The consequence was not a cosmetic stale dot. `finish()` is the only thing that sets `ended_at`,
 * so the row stayed `thinking` for the full retention window; and because `thinking` outranks every
 * terminal state in `ACTIVITY_SEVERITY`, that dead row kept winning the roster reduction, pinning a
 * channel open on work that ended days ago. Nothing could clear it: the abandoned-run sweeper read
 * `thread_locks`, and a chat run takes no lock.
 *
 * Every test below is named for the guarantee rather than the symptom, because the symptom is
 * "Working" on a channel and the guarantee is that a turn settles exactly once however it ends.
 */
describe("a turn torn down while beforeRun is still outstanding", () => {
  /** An inner whose run never starts, so nothing but the teardown can settle the turn. */
  class NeverRunsAgent extends AbstractAgent {
    started = 0;
    constructor() {
      super({ agentId: "bot_never", description: "never runs" });
    }
    override run(): Observable<BaseEvent> {
      this.started += 1;
      return new Observable<BaseEvent>(() => {
        /* never emits, never completes */
      });
    }
  }

  /** A `beforeRun` whose resolution this test controls, standing in for the database round trip. */
  const deferredBeforeRun = () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    return {
      gate,
      release,
      beforeRun: async () => {
        await gate;
      },
    };
  };

  test("still settles exactly once", async () => {
    const inner = new NeverRunsAgent();
    const { gate, release, beforeRun } = deferredBeforeRun();
    const settled: unknown[] = [];
    const enforced = new EnforcedAgent(inner, {
      beforeRun,
      onTurnSettled: (params) => {
        settled.push(params);
      },
    });

    const subscription = enforced
      .run({
        threadId: "t",
        runId: "r",
        messages: [] as Message[],
      } as never)
      .subscribe({ next: () => undefined, error: () => undefined });

    // The unsubscribe lands while `beforeRun` is still waiting: the record is written, the turn is
    // not yet running, and nothing has claimed it.
    subscription.unsubscribe();
    release();
    await gate;
    // Let the `.then(start)` continuation run, which is where a lost settle used to be lost.
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(settled).toHaveLength(1);
    // And the inner agent was never subscribed, so no answer was thrown away.
    expect(inner.started).toBe(0);
  });

  test("names the run that was settled, so its record can be closed", async () => {
    const inner = new NeverRunsAgent();
    const { release, beforeRun } = deferredBeforeRun();
    const settled: Record<string, unknown>[] = [];
    const enforced = new EnforcedAgent(inner, {
      beforeRun,
      onTurnSettled: (params) => {
        settled.push(params as Record<string, unknown>);
      },
    });

    const subscription = enforced
      .run({
        threadId: "thread-1",
        runId: "run-1",
        messages: [] as Message[],
      } as never)
      .subscribe({ next: () => undefined, error: () => undefined });
    subscription.unsubscribe();
    release();
    await new Promise((resolve) => setTimeout(resolve, 5));

    // Without the run id there is no way to find the row this settle is meant to close, and the
    // ghost survives a settlement that did happen.
    expect(settled[0]?.runId).toBe("run-1");
    expect(settled[0]?.threadId).toBe("thread-1");
  });

  test("a refused turn is neither settled nor billed", async () => {
    /*
     * THE OTHER HALF, AND THE ONE THAT WOULD HAVE BEEN A REGRESSION.
     *
     * `beforeRun` throws before it writes anything for an ineligible turn, a paused coworker and a
     * thread belonging to somebody else. A refused turn has no row to close and must not be
     * charged — so settling on teardown alone would take a free refusal and turn it into a zero-token
     * deduction plus a usage row, for every refusal the deployment ever makes.
     *
     * This is the case that distinguishes "the subscriber went away" from "there is a record that
     * needs finishing", and it is why the teardown settles on the second and not the first.
     */
    const inner = new NeverRunsAgent();
    const settled: unknown[] = [];
    const enforced = new EnforcedAgent(inner, {
      beforeRun: async () => {
        throw new Error("This coworker is paused and is not taking work.");
      },
      onTurnSettled: (params) => {
        settled.push(params);
      },
    });

    const errored = new Promise<unknown>((resolve) => {
      enforced
        .run({
          threadId: "t",
          runId: "r",
          messages: [] as Message[],
        } as never)
        .subscribe({
          next: () => undefined,
          error: resolve,
          complete: () => undefined,
        });
    });
    await errored;
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(settled).toHaveLength(0);
  });

  test("a turn that ran to completion is still settled exactly once", async () => {
    // The idempotence guard on the new teardown path: a started turn settles through its own
    // completion and again through the teardown, and must be charged for one turn, not two.
    const inner = new ScriptedAgent([finishedWithUsage(700, 300)]);
    const settled: unknown[] = [];
    const enforced = new EnforcedAgent(inner, {
      beforeRun: async () => undefined,
      onTurnSettled: (params) => {
        settled.push(params);
      },
    });

    await new Promise<void>((resolve, reject) => {
      enforced
        .run({
          threadId: "t",
          runId: "r",
          messages: [] as Message[],
        } as never)
        .subscribe({ next: () => undefined, error: reject, complete: resolve });
    });

    // Exactly one, and it names the run. The token counts are not asserted on this path: a
    // `ScriptedAgent` emits straight down its own observable rather than through its subscribers,
    // so `TurnMeter` never observes them here. That is a property of the fixture, and the runAgent
    // tests above are where the metering maths is pinned.
    expect(settled).toHaveLength(1);
    expect((settled[0] as Record<string, unknown>).runId).toBe("r");
  });
});

/*
 * A RUN THAT SAYS IT IS STILL GOING.
 *
 * The settled turn above is what stops a ghost being made. This is what clears the ones that already
 * exist, and the ones no care in a teardown can reach: a process killed mid-turn takes its `finally`
 * and its subscriber with it, and the row it left behind is indistinguishable from a live run by
 * anything the sweeper could read — until the run beats while it works.
 */
describe("a running turn beats", () => {
  /*
   * A short interval rather than the production one.
   *
   * The constant is deliberately a fraction of the abandoned-run grace period, and that relationship
   * is what keeps a live run out of the sweeper's candidate set. Waiting it out for real would make
   * this file take a minute; the interval is injected for exactly this, and the production value is
   * pinned separately below so the ratio cannot silently rot.
   */
  const BEAT_MS = 10;
  const settle = (ms = BEAT_MS * 6) =>
    new Promise((resolve) => setTimeout(resolve, ms));

  /** An inner that stays open until released, so a beat has a live run to beat for. */
  class HeldAgent extends AbstractAgent {
    private release!: () => void;
    constructor() {
      super({ agentId: "bot_held", description: "held open" });
      this.release = () => undefined;
    }
    override run(): Observable<BaseEvent> {
      return new Observable<BaseEvent>((observer) => {
        this.release = () => {
          observer.complete();
        };
      });
    }
    finish(): void {
      this.release();
    }
  }

  test("the production interval leaves room inside the sweeper's grace period", () => {
    /*
     * THE INVARIANT THE WHOLE THING RESTS ON, asserted rather than described.
     *
     * A run is kept out of `sweepAbandonedRuns` purely by beating faster than the grace period
     * expires. If these two numbers ever crossed, a live run would be reported dead while it was
     * working — and the failure would be a channel saying "The connection was closed" about a run
     * that was about to answer, which is worse in a different way than the ghost it replaced.
     *
     * A factor of two is the floor: one interval of slack means a single slow beat, which a busy
     * event loop will eventually produce, is enough to end a live run.
     */
    expect(TURN_HEARTBEAT_MS).toBeLessThanOrEqual(ABANDONED_RUN_GRACE_MS / 2);
    // And the production interval is the one shipped, not a test's.
    expect(TURN_HEARTBEAT_MS).toBe(20_000);
  });

  test("beats while running, and stops when the turn settles", async () => {
    const inner = new HeldAgent();
    const beats: string[] = [];
    const enforced = new EnforcedAgent(inner, {
      heartbeatIntervalMs: BEAT_MS,
      heartbeat: async (input) => {
        beats.push(input.runId);
        return true;
      },
      onTurnSettled: () => undefined,
    });

    const done = new Promise<void>((resolve) => {
      enforced
        .run({
          threadId: "t",
          runId: "run-beat",
          messages: [] as Message[],
        } as never)
        .subscribe({
          next: () => undefined,
          error: () => undefined,
          complete: resolve,
        });
    });

    await settle();
    const whileRunning = beats.length;
    inner.finish();
    await done;

    expect(whileRunning).toBeGreaterThan(0);
    expect(beats.every((id) => id === "run-beat")).toBe(true);

    // And it stops: a beat for a settled run would be claiming a liveness already withdrawn.
    const afterSettling = beats.length;
    await settle();
    expect(beats.length).toBe(afterSettling);
  });

  test("stops beating when the run says it is no longer open", async () => {
    const inner = new HeldAgent();
    const beats: string[] = [];
    const enforced = new EnforcedAgent(inner, {
      heartbeatIntervalMs: BEAT_MS,
      // False is the sweeper having ended the run out from under this one.
      heartbeat: async (input) => {
        beats.push(input.runId);
        return false;
      },
      onTurnSettled: () => undefined,
    });

    const done = new Promise<void>((resolve) => {
      enforced
        .run({
          threadId: "t",
          runId: "run-swept",
          messages: [] as Message[],
        } as never)
        .subscribe({
          next: () => undefined,
          error: () => undefined,
          complete: resolve,
        });
    });

    await settle();
    const afterFirst = beats.length;
    expect(afterFirst).toBeGreaterThan(0);

    // The timer stops itself on the first refusal, so further intervals add nothing.
    await settle();
    expect(beats.length).toBe(afterFirst);

    inner.finish();
    await done;
  });

  test("a heartbeat that throws does not end the turn", async () => {
    const inner = new ScriptedAgent([finishedWithUsage(400, 200)]);
    const settled: unknown[] = [];
    const enforced = new EnforcedAgent(inner, {
      heartbeatIntervalMs: BEAT_MS,
      // A liveness signal that failed to write is not somebody's lost answer.
      heartbeat: () => {
        throw new Error("the database is unreachable");
      },
      onTurnSettled: (params) => {
        settled.push(params);
      },
    });

    await new Promise<void>((resolve, reject) => {
      enforced
        .run({
          threadId: "t",
          runId: "r",
          messages: [] as Message[],
        } as never)
        .subscribe({ next: () => undefined, error: reject, complete: resolve });
    });

    expect(settled).toHaveLength(1);
  });

  test("a cloned agent keeps the beat, because the request path runs a clone", async () => {
    /*
     * THE ONE THAT IS EASY TO MISS.
     *
     * The request path clones the agent it is about to run — that is how a run gets its own message
     * list — and `clone()` used to drop `beforeRun`, which is why the eligibility check was skipped
     * for every chat message until it was put back. A heartbeat dropped the same way is worse in
     * effect rather than better: `beforeRun` arriving without a beat means a turn that runs to
     * completion while never once saying it is alive, which is exactly the shape the sweeper cannot
     * tell from a killed process.
     */
    const inner = new HeldAgent();
    const beats: string[] = [];
    const enforced = new EnforcedAgent(inner, {
      heartbeatIntervalMs: BEAT_MS,
      heartbeat: async (input) => {
        beats.push(input.runId);
        return true;
      },
      onTurnSettled: () => undefined,
    });

    const clone = enforced.clone() as EnforcedAgent;
    const subscription = clone
      .run({
        threadId: "t",
        runId: "run-clone",
        messages: [] as Message[],
      } as never)
      .subscribe({
        next: () => undefined,
        error: () => undefined,
        complete: () => undefined,
      });

    await settle();
    expect(beats).toContain("run-clone");

    // Torn down rather than finished: `clone()` cloned the inner too, so the handle held here is
    // not the one whose observable is open. Unsubscribing is the route that needs no handle.
    subscription.unsubscribe();
  });
});

/*
 * There IS no free trial any more, and that is asserted rather than left implicit.
 *
 * This used to hold five hours of it, measured from signup, and every test in the file above it still
 * describes credits and a balance. What replaced it is the meter: a person sees a percentage of what
 * they bought and when it resets, and there is no trial to time out from.
 *
 * So the trial exports are GONE rather than stubbed to return false. A test that imported
 * `isTrialActive` would fail at the import with a syntax error rather than quietly pass against a stub,
 * which is the outcome wanted here: the subject was removed, and anything still reaching for it is
 * reaching for something that no longer exists.
 */
describe("the free trial is gone", () => {
  test("the trial exports are not offered at all", async () => {
    const metering = await import("../src/billing/metering");
    expect(metering).not.toHaveProperty("isTrialActive");
    expect(metering).not.toHaveProperty("trialEndsAt");
    expect(metering).not.toHaveProperty("TRIAL_HOURS");
  });

  test("and nothing decides coverage by asking how long ago somebody signed up", async () => {
    /*
     * The failure this prevents is subtle and was live: `planCoverage` returning true for a fresh
     * account means a new person gets the product for nothing, which is a trial by another name. So the
     * coverage function is called with an account that has no subscription at all, and must refuse.
     */
    const { planCoverage } = await import("../src/billing/metering");
    // A read against a database this test does not have: the point is that it does not return covered
    // before it has even looked anything up, which is what a trial branch would do.
    const coverage = await planCoverage(
      {} as never,
      "a-user-who-never-subscribed",
    ).catch(() => ({ covered: false }) as const);
    expect(coverage.covered).toBe(false);
  });
});

describe("routine turn charging", () => {
  function harness(options: {
    events?: BaseEvent[];
    charge?: (input: {
      ownerUserId: string;
      agentId: string;
      threadId: string;
      promptTokens: number;
      completionTokens: number;
      browserDurationSeconds: number;
    }) => Promise<number>;
  }) {
    const seen: unknown[] = [];
    const agent = new ScriptedAgent([], "bot_helper");
    (agent as { messages: Message[] }).messages = [
      { id: "u1", role: "user", content: "Go." },
    ] as Message[];

    const intelligence = {
      getOrCreateThread: async (params: {
        threadId: string;
        userId: string;
        agentId: string;
      }) => ({ thread: { id: params.threadId }, created: false }),
      getThreadMessages: async () => ({ messages: [] }),
      ɵacquireThreadLock: async (params: {
        threadId: string;
        runId: string;
        userId: string;
        agentId: string;
        ttlSeconds?: number;
      }) => ({
        threadId: params.threadId,
        runId: params.runId,
        joinToken: "t",
      }),
      ɵrenewThreadLock: async (params: { threadId: string; runId: string }) =>
        params,
      ɵcleanupThreadLock: async () => undefined,
    };

    const events = options.events ?? [];
    const runner = {
      run: (request: { threadId: string; agent: ScriptedAgent }) => ({
        subscribe(observer: {
          next: (event: BaseEvent) => void;
          error: (error: unknown) => void;
          complete: () => void;
        }) {
          // Like the real runner, events reach both the run observer and
          // the agent's own subscribers (where the meter listens).
          const input = {
            threadId: request.threadId,
            runId: "run_1",
            messages: request.agent.messages,
          } as never;
          for (const event of events) {
            for (const subscriber of [...request.agent.subscribers]) {
              void (subscriber as AgentSubscriber).onEvent?.({
                event,
                messages: request.agent.messages,
                state: request.agent.state,
                agent: request.agent,
                input,
              });
            }
            observer.next(event);
          }
          request.agent.messages = [
            ...request.agent.messages,
            { id: "a1", role: "assistant", content: "Done." },
          ] as Message[];
          observer.complete();
          return { unsubscribe: () => undefined };
        },
      }),
      stop: async () => true,
    };

    const runTurn = createTurnRunner({
      // biome-ignore lint/suspicious/noExplicitAny: narrow structural fakes, on purpose.
      intelligence: intelligence as any,
      // biome-ignore lint/suspicious/noExplicitAny: narrow structural fakes, on purpose.
      runner: runner as any,
      buildAgentFor: async () => agent,
      ...(options.charge ? { chargeUsage: options.charge } : {}),
      heartbeatMs: 1_000_000,
    });

    return {
      seen,
      run: () =>
        runTurn({
          ownerUserId: "user_owner",
          routineId: "routine_1",
          agentId: "bot_helper",
          threadId: "thread_1",
          instruction: "Report.",
        }),
    };
  }

  test("a finished turn reports real deducted credits", async () => {
    const charged: unknown[] = [];
    const { run } = harness({
      events: [finishedWithUsage(25_000, 5_000)],
      charge: async (input) => {
        charged.push(input);
        return 7;
      },
    });
    const result = await run();
    expect(result).toEqual({
      replyText: "Done.",
      creditsDeducted: 7,
    });
    const first = charged[0] as Record<string, unknown>;
    expect(first.ownerUserId).toBe("user_owner");
    expect(first.promptTokens).toBe(25_000);
  });

  test("without a charger the turn still answers, uncharged", async () => {
    const { run } = harness({});
    const result = await run();
    expect(result).toEqual({ replyText: "Done." });
  });

  test("a looping routine turn is stopped, not posted", async () => {
    const { run } = harness({
      events: Array.from({ length: 120 }, (_, index) => toolStart(`c${index}`)),
    });
    await expect(run()).rejects.toThrow(/100 iterative tool calls/);
  });

  test("a long but legitimate multi-step turn under the cap is not stopped", async () => {
    const { run } = harness({
      events: Array.from({ length: 20 }, (_, index) => toolStart(`c${index}`)),
    });
    const result = await run();
    expect(result).toEqual({ replyText: "Done." });
  });

  /*
   * Why a routine's turn cannot be wrapped in `EnforcedAgent`, pinned as a test because the reason
   * is invisible from the wiring: the wrapper's `messages` array stays as the caller seeded it, and
   * a routine recovers its reply by diffing that array. Without this, every firing on a deployment
   * that "fixed" the missing enforcement wrapper would be recorded as
   *
   *     "The turn finished without saying anything."
   *
   * The wrapper is proven to break the reply below, and proven to charge a second time beside the
   * runner's own `chargeUsage`. Both are the cost of the wrapper, so the routine keeps its own
   * metering in `run-turn.ts` and this test is what stops anyone reaching for the wrapper to "fix"
   * the missing turn enforcement without reading what it does to the reply.
   */
  test("an EnforcedAgent wrapper would hide a routine's reply from the diff", async () => {
    const inner = new ScriptedAgent([], "bot_helper");
    (inner as { messages: Message[] }).messages = [
      { id: "u1", role: "user", content: "Go." },
    ] as Message[];
    const wrapped = new EnforcedAgent(inner);
    // Seeded exactly as `run-turn.ts` seeds a routine's turn.
    (wrapped as { messages: Message[] }).messages = [
      { id: "u1", role: "user", content: "Go." },
    ] as Message[];

    // The inner agent answers, as a real one does by appending to its own message list.
    await inner.runAgent();
    (inner as { messages: Message[] }).messages = [
      ...inner.messages,
      { id: "a1", role: "assistant", content: "Done." },
    ] as Message[];

    // The wrapper is what the caller holds, and what the diff reads. It still shows only the
    // seeded user message, so `run-turn.ts`'s diff finds nothing new and reports an empty reply.
    expect((wrapped as { messages: Message[] }).messages).toHaveLength(1);
    // The answer exists — on the agent that produced it, and nowhere the caller can see.
    expect(inner.messages).toHaveLength(2);
  });

  test("the fatigue threshold the runner acts on is the one the page reports", async () => {
    // One number, imported by both the rule and its user-facing sentence. If these ever diverge the
    // page says "Failed 10 times" about a rule that acts at something else.
    expect(FATIGUE_LIMIT).toBe(10);
  });
});
