import { describe, expect, test } from "bun:test";
import type {
  AgentSubscriber,
  BaseEvent,
  Message,
  RunAgentResult,
} from "@ag-ui/client";
import { AbstractAgent, EventType } from "@ag-ui/client";
import { Observable } from "rxjs";
import { EnforcedAgent, LoopBreakerLimitError } from "../src/billing/metering";
import { createTurnRunner } from "../src/routines/run-turn";

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
});
