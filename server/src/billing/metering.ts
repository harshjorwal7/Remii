import { randomUUID } from "node:crypto";
import type {
  AgentSubscriber,
  BaseEvent,
  Message,
  RunAgentInput,
  RunAgentParameters,
  RunAgentResult,
} from "@ag-ui/client";
import { AbstractAgent, EventType } from "@ag-ui/client";
import { and, eq } from "drizzle-orm";
import { Observable } from "rxjs";
import type { Database } from "../db/client";
import { creditLedger, subscriptions, usageRecords, users } from "../db/schema";

/*
 * NO FREE TRIAL.
 *
 * There were five hours of it, and it is gone: a plan either includes a computer or it does not, and a
 * trial that does not is a trial on a product with no computer in it. That is not a smaller version of
 * the product, it is a different one — the whole point of what this deployment sells is a real desktop,
 * and a trial that could not afford one would teach a new person what the product is by showing them
 * that it is not.
 *
 * What replaces it is the meter, not a countdown: a person sees what they have bought and what is left
 * of it. The credits these constants configured are gone with it — spend is denominated in dollars now,
 * in `budget.ts`.
 */

/** Tiers whose subscription covers the turn itself, rather than the allowance deciding. */
const COVERED_TIERS = new Set(["starter", "pro", "power", "byok"]);

/** Maximum iterative tool calls permitted in a single user turn. SaaS mode: high, so a Bot
 * doing a long multi-step job (dozens of Composio + browser calls) is not cut off mid-task. */
export const MAX_TURN_TOOL_CALLS = 100;

/** Maximum credits a routine may consume in a single day (rolling 24h) before tripping the circuit breaker. */
export const MAX_ROUTINE_DAILY_CREDITS = 30;

export class LoopBreakerLimitError extends Error {
  readonly limit: number;

  constructor(
    limit = MAX_TURN_TOOL_CALLS,
    message = `Agent turn exceeded maximum limit of ${limit} iterative tool calls.`,
  ) {
    super(message);
    this.name = "LoopBreakerLimitError";
    this.limit = limit;
  }
}

export type TurnEligibilityResult =
  | {
      allowed: true;
      user: { id: string; creditBalance: number; isBanned: boolean };
    }
  | {
      allowed: false;
      status: 401 | 402 | 403;
      error: string;
      message?: string;
    };

export type PlanCoverage =
  | { covered: true; reason: "subscription" }
  | { covered: false };

/**
 * Whether turns are covered: an active paid subscription.
 *
 * Pro covers the computer as well as the model; the BYOK add-on covers the computer while the subscriber
 * pays model spend directly. There is no trial any more — see the note at the top of this file for why
 * a free period that could not afford a computer would be teaching the wrong lesson.
 */
export async function planCoverage(
  database: Database,
  userId: string,
): Promise<PlanCoverage> {
  const [subRow] = await database
    .select({
      tier: subscriptions.tier,
      status: subscriptions.status,
      byokAddon: subscriptions.byokAddon,
    })
    .from(subscriptions)
    .where(eq(subscriptions.userId, userId))
    .limit(1);
  if (!subRow) return { covered: false };
  if (subRow.byokAddon) return { covered: true, reason: "subscription" };
  if (
    (subRow.status === "active" || subRow.status === "trialing") &&
    COVERED_TIERS.has(subRow.tier)
  ) {
    return { covered: true, reason: "subscription" };
  }
  return { covered: false };
}

/**
 * Record usage without moving money. Covered turns (trial, plan) still write
 * usage_records so the window bars move; only the balance is untouched.
 */
export async function recordUsage(
  database: Database,
  input: DeductCreditsInput,
): Promise<{ usageRecordId: string; creditsComputed: number }> {
  const creditsComputed = calculateTurnCredits({
    promptTokens: input.promptTokens,
    completionTokens: input.completionTokens,
    browserDurationSeconds: input.browserDurationSeconds,
  });
  const usageRecordId = `usg_${Date.now()}_${randomUUID().slice(0, 8)}`;
  await database.insert(usageRecords).values({
    id: usageRecordId,
    userId: input.userId,
    channelId: input.channelId ?? "default",
    agentId: input.agentId,
    model: input.model,
    promptTokens: input.promptTokens ?? 0,
    completionTokens: input.completionTokens ?? 0,
    browserDurationSeconds: input.browserDurationSeconds ?? 0,
    creditsDeducted: creditsComputed,
    createdAt: new Date(),
  });
  return { usageRecordId, creditsComputed };
}

/**
 * Verify whether a user is eligible to initiate a turn.
 *
 * Enforcement rules:
 * 1. Must be authenticated and exist in users table -> otherwise 401
 * 2. user.isBanned must be false -> otherwise 403 Forbidden
 * 3. Covered by trial or plan -> allowed without touching the balance
 * 4. Otherwise user.creditBalance must be > 0 -> otherwise 402 Payment Required
 */
export async function verifyTurnEligibility(
  database: Database,
  userId: string | undefined | null,
): Promise<TurnEligibilityResult> {
  if (!userId) {
    return {
      allowed: false,
      status: 401,
      error: "Authentication required.",
    };
  }

  const [userRow] = await database
    .select({
      id: users.id,
      creditBalance: users.creditBalance,
      isBanned: users.isBanned,
      createdAt: users.createdAt,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!userRow) {
    return {
      allowed: false,
      status: 401,
      error: "Authentication required.",
    };
  }

  if (userRow.isBanned) {
    return {
      allowed: false,
      status: 403,
      error: "Forbidden",
      message: "User is banned.",
    };
  }

  // Trial first: five hours from signup, full product, no balance touched.
  const coverage = await planCoverage(database, userId).catch(() => null);
  if (coverage?.covered) {
    return {
      allowed: true,
      user: userRow,
    };
  }

  if (userRow.creditBalance <= 0) {
    return {
      allowed: false,
      status: 402,
      error: "Payment Required",
      message:
        "Your trial has ended and you are out of credits. Upgrade to continue.",
    };
  }

  return {
    allowed: true,
    user: userRow,
  };
}

export type ExtractedTokens = {
  promptTokens: number;
  completionTokens: number;
};

/**
 * Extracts input and output tokens from stream events (RUN_FINISHED, STEP_FINISHED, rawEvent, metadata).
 */
export function extractUsageTokens(event: unknown): ExtractedTokens {
  let promptTokens = 0;
  let completionTokens = 0;

  if (!event || typeof event !== "object") {
    return { promptTokens, completionTokens };
  }

  const record = event as Record<string, unknown>;

  const checkCandidate = (val: unknown) => {
    if (!val || typeof val !== "object") return;
    if (Array.isArray(val)) {
      for (const item of val) {
        checkCandidate(item);
      }
      return;
    }

    const obj = val as Record<string, unknown>;
    const p =
      obj.promptTokens ??
      obj.prompt_tokens ??
      obj.inputTokens ??
      obj.input_tokens;
    const c =
      obj.completionTokens ??
      obj.completion_tokens ??
      obj.outputTokens ??
      obj.output_tokens;

    if (typeof p === "number" && Number.isSafeInteger(p) && p > 0) {
      promptTokens = Math.max(promptTokens, p);
    }
    if (typeof c === "number" && Number.isSafeInteger(c) && c > 0) {
      completionTokens = Math.max(completionTokens, c);
    }
  };

  if ("usage" in record) {
    checkCandidate(record.usage);
  }
  if (
    "rawEvent" in record &&
    record.rawEvent &&
    typeof record.rawEvent === "object"
  ) {
    const raw = record.rawEvent as Record<string, unknown>;
    if ("usage" in raw) checkCandidate(raw.usage);
    if ("totalUsage" in raw) checkCandidate(raw.totalUsage);
  }
  if (
    "metadata" in record &&
    record.metadata &&
    typeof record.metadata === "object"
  ) {
    const meta = record.metadata as Record<string, unknown>;
    if ("usage" in meta) checkCandidate(meta.usage);
  }

  return { promptTokens, completionTokens };
}

/**
 * Calculate the credits to deduct for a turn based on token counts and container seconds.
 * Minimum deduction is 1 credit.
 */
export function calculateTurnCredits(params: {
  promptTokens?: number;
  completionTokens?: number;
  browserDurationSeconds?: number;
}): number {
  const baseCredits = 1;
  const totalTokens =
    (params.promptTokens ?? 0) + (params.completionTokens ?? 0);
  const tokenCredits = Math.floor(totalTokens / 10_000);
  const containerCredits = Math.floor(
    (params.browserDurationSeconds ?? 0) / 60,
  );

  return Math.max(1, baseCredits + tokenCredits + containerCredits);
}

export type DeductCreditsInput = {
  userId: string;
  channelId?: string;
  agentId: string;
  model: string;
  promptTokens?: number;
  completionTokens?: number;
  browserDurationSeconds?: number;
  reason?: string;
};

export type DeductCreditsResult = {
  creditsDeducted: number;
  balanceAfter: number;
  ledgerId: string;
  usageRecordId: string;
};

/**
 * SaaS mode: no billing. Turns are never charged, so this records nothing and deducts nothing.
 * Kept (rather than deleted) because the runtime calls it per turn and expects a result.
 */
export async function deductTurnCredits(
  _database: Database,
  _input: DeductCreditsInput,
): Promise<DeductCreditsResult> {
  return {
    creditsDeducted: 0,
    balanceAfter: 0,
    ledgerId: "saas-no-billing",
    usageRecordId: "saas-no-billing",
  };
}

/**
 * Atomically grants credits (positive delta) with a ledger row.
 *
 * The single writer for every grant path — subscription activation, renewal,
 * one-time top-up webhooks, manual admin grants — so a retried webhook cannot
 * double-credit: callers de-duplicate on their own idempotency (webhook event
 * ids, subscription rows) and this guarantees the balance and the ledger move
 * together under a row lock.
 */
export async function grantCredits(
  database: Database,
  input: {
    userId: string;
    credits: number;
    reason: string;
    channelId?: string;
    idempotencyKey?: string;
  },
): Promise<{ balanceAfter: number; ledgerId: string }> {
  if (!Number.isSafeInteger(input.credits) || input.credits <= 0) {
    throw new Error("Grant amount must be a positive integer.");
  }
  return database.transaction(async (tx) => {
    const [userRow] = await tx
      .select({ creditBalance: users.creditBalance })
      .from(users)
      .where(eq(users.id, input.userId))
      .for("update");
    if (input.idempotencyKey) {
      const [existing] = await tx
        .select({
          id: creditLedger.id,
          balanceAfter: creditLedger.balanceAfter,
        })
        .from(creditLedger)
        .where(
          and(
            eq(creditLedger.idempotencyKey, input.idempotencyKey),
            eq(creditLedger.userId, input.userId),
          ),
        )
        .limit(1);
      if (existing) {
        return { balanceAfter: existing.balanceAfter, ledgerId: existing.id };
      }
    }
    const balanceAfter = (userRow?.creditBalance ?? 0) + input.credits;
    await tx
      .update(users)
      .set({ creditBalance: balanceAfter, updatedAt: new Date() })
      .where(eq(users.id, input.userId));
    const ledgerId = `cld_${Date.now()}_${randomUUID().slice(0, 8)}`;
    await tx.insert(creditLedger).values({
      id: ledgerId,
      userId: input.userId,
      delta: input.credits,
      balanceAfter,
      reason: input.reason,
      channelId: input.channelId,
      idempotencyKey: input.idempotencyKey,
      createdAt: new Date(),
    });
    return { balanceAfter, ledgerId };
  });
}

/**
 * Counts tool calls made in messages since the last user message.
 */ export function countHistoryToolCalls(
  messages: readonly Message[],
): number {
  let count = 0;
  // Iterate backwards to find latest user message
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") {
      lastUserIdx = i;
      break;
    }
  }

  const slice = lastUserIdx >= 0 ? messages.slice(lastUserIdx + 1) : messages;
  for (const msg of slice) {
    const record = msg as unknown as Record<string, unknown>;
    if (record.toolCalls && Array.isArray(record.toolCalls)) {
      count += record.toolCalls.length;
    } else if (record.role === "assistant" && record.toolCallId) {
      count += 1;
    }
  }

  return count;
}

/**
 * Loop breaker: enforces maximum iterative tool calls per user turn.
 */
export class TurnLoopBreaker {
  private count: number;
  readonly limit: number;

  constructor(initialCount = 0, limit = MAX_TURN_TOOL_CALLS) {
    this.count = initialCount;
    this.limit = limit;
  }

  get currentCount(): number {
    return this.count;
  }

  /**
   * Records a tool call. If the count exceeds the limit, throws LoopBreakerLimitError.
   */
  recordToolCall(): void {
    this.count += 1;
    if (this.count > this.limit) {
      throw new LoopBreakerLimitError(
        this.limit,
        `Loop breaker: Hard-stopping turn because iterative tool calls exceeded ${this.limit}.`,
      );
    }
  }
}

/**
 * Lightweight per-turn tracker for elapsed container seconds from computer actions.
 */
export type ContainerUsageTracker = {
  recordElapsed(seconds: number): void;
  getElapsed(): number;
};

export function createContainerUsageTracker(): ContainerUsageTracker {
  let totalSeconds = 0;
  return {
    recordElapsed(seconds: number) {
      if (typeof seconds === "number" && seconds > 0) {
        totalSeconds += Math.ceil(seconds);
      }
    },
    getElapsed() {
      return totalSeconds;
    },
  };
}

export type TurnSettlement = {
  promptTokens: number;
  completionTokens: number;
  browserDurationSeconds: number;
  threadId: string;
  agentId: string;
  /**
   * The run that settled, when the caller supplied one.
   *
   * Added because a settled turn is told its THREAD and its Bot, which between them name a
   * conversation rather than a run — and a conversation can be run through more than once. Anything
   * that records runs rather than threads needs the run itself, and looking it up by thread and Bot
   * would have to assume a run is still the newest on its thread, which is the assumption a settled
   * turn is least able to make.
   */
  runId?: string;
};

export type EnforcedAgentOptions = {
  maxToolCalls?: number;
  getContainerSeconds?: () => number;
  onTurnSettled?: (params: TurnSettlement) => Promise<void> | void;
  beforeRun?: (input: RunAgentInput) => Promise<void>;
};

/**
 * Per-turn metering state shared by both run paths.
 *
 * `run()` and `runAgent()` both dispatch every event to the agent's
 * subscribers, so one subscriber observes both: the CopilotKit request path
 * and the routine runner's headless path. Counting anywhere else would cover
 * one path and silently miss the other.
 */
class TurnMeter {
  private readonly breaker: TurnLoopBreaker;
  private promptTokens = 0;
  private completionTokens = 0;
  private settled = false;

  constructor(maxToolCalls: number, initialCount = 0) {
    this.breaker = new TurnLoopBreaker(initialCount, maxToolCalls);
  }

  observe(event: BaseEvent): void {
    if (event.type === EventType.TOOL_CALL_START) {
      // Throws past the limit; the caller aborts the run with it.
      this.breaker.recordToolCall();
    }
    const tokens = extractUsageTokens(event);
    if (tokens.promptTokens > 0) {
      this.promptTokens = Math.max(this.promptTokens, tokens.promptTokens);
    }
    if (tokens.completionTokens > 0) {
      this.completionTokens = Math.max(
        this.completionTokens,
        tokens.completionTokens,
      );
    }
  }

  settle(
    settle: (
      params: Omit<TurnSettlement, "threadId" | "agentId" | "runId">,
    ) => void,
    getContainerSeconds?: () => number,
  ): void {
    if (this.settled) return;
    this.settled = true;
    settle({
      promptTokens: this.promptTokens,
      completionTokens: this.completionTokens,
      browserDurationSeconds: getContainerSeconds?.() ?? 0,
    });
  }
}

/**
 * An AbstractAgent decorator that enforces, on every run path:
 * 1. Loop breaker (hard-stop if iterative tool calls exceed maxToolCalls, default
 *    MAX_TURN_TOOL_CALLS).
 * 2. Token extraction from LLM response events.
 * 3. Container duration tracking from computer actions.
 * 4. Turn settlement callback (for atomic credit deduction).
 */
export class EnforcedAgent extends AbstractAgent {
  private readonly inner: AbstractAgent;
  private readonly maxToolCalls: number;
  private readonly getContainerSeconds?: () => number;
  private readonly onTurnSettled?: EnforcedAgentOptions["onTurnSettled"];
  private readonly beforeRun?: EnforcedAgentOptions["beforeRun"];

  constructor(inner: AbstractAgent, options?: EnforcedAgentOptions) {
    super({ agentId: inner.agentId, description: inner.description });
    this.inner = inner;
    this.maxToolCalls = options?.maxToolCalls ?? MAX_TURN_TOOL_CALLS;
    this.getContainerSeconds = options?.getContainerSeconds;
    this.onTurnSettled = options?.onTurnSettled;
    this.beforeRun = options?.beforeRun;
  }

  private meterFor(input: {
    threadId?: string;
    runId?: string;
    messages?: readonly Message[];
  }): {
    meter: TurnMeter;
    subscriber: AgentSubscriber;
    settleNow: () => void;
  } {
    const meter = new TurnMeter(
      this.maxToolCalls,
      countHistoryToolCalls(
        (input.messages ?? []) as unknown as readonly Message[],
      ),
    );
    const threadId = typeof input.threadId === "string" ? input.threadId : "";
    const runId = typeof input.runId === "string" ? input.runId : undefined;
    const settleNow = () =>
      meter.settle(
        (partial) =>
          void this.onTurnSettled?.({
            ...partial,
            threadId,
            agentId: this.agentId ?? "unknown",
            // Named here, from the run that is settling, rather than looked up afterwards by its
            // thread. See the field's note.
            ...(runId ? { runId } : {}),
          }),
        this.getContainerSeconds,
      );
    const subscriber: AgentSubscriber = {
      onEvent: ({ event }) => {
        try {
          meter.observe(event as BaseEvent);
        } catch (error) {
          /*
           * THE REASON TRAVELS WITH THE ABORT, or the run stops for a reason the transcript will
           * never show.
           *
           * The loop this ends is a `RemiLoopAgent`, whose abort handler reads `signal.reason` back
           * to tell the browser what ended the turn. `abortRun()` with no argument aborts with no
           * reason, and the loop then falls back to its generic sentence — so a turn genuinely
           * cut off by the breaker reported itself as simply "stopped", which is both wrong and
           * indistinguishable from a person pressing Stop. The loop breaker is the one limit here
           * that a person cannot see, so it is the one that most needs to say so.
           */
          const reason =
            error instanceof Error && error.message
              ? error.message
              : "This turn was stopped before the Bot finished answering.";
          try {
            /*
             * `abortRunWithReason` where the inner loop has one, `abortRun` otherwise. The loop
             * reads `signal.reason` back to tell the browser what ended the turn, so the breaker
             * reaching it without its message would be reported as a bare stop — indistinguishable
             * from a person pressing Stop, and wrong about the one limit they cannot see.
             */
            const withReason = this.inner as {
              abortRunWithReason?: (reason: string) => void;
            };
            if (typeof withReason.abortRunWithReason === "function") {
              withReason.abortRunWithReason.call(this.inner, reason);
            } else {
              this.inner.abortRun();
            }
          } catch {}
          settleNow();
          throw error instanceof Error ? error : new Error(String(error));
        }
      },
      onRunFailed: () => {
        settleNow();
      },
      onRunFinalized: () => {
        settleNow();
      },
    };
    return { meter, subscriber, settleNow };
  }

  override run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable<BaseEvent>((observer) => {
      let cancelled = false;
      let detach: (() => void) | undefined;

      const start = () => {
        if (cancelled) return;
        const { subscriber, settleNow } = this.meterFor(input);
        const attached = this.inner.subscribe(subscriber);
        detach = () => {
          settleNow();
          attached.unsubscribe();
        };
        const subscription = this.inner.run(input).subscribe({
          next: (event) => observer.next(event),
          error: (error) => {
            detach?.();
            observer.error(error);
          },
          complete: () => {
            detach?.();
            observer.complete();
          },
        });
        const originalDetach = detach;
        detach = () => {
          originalDetach?.();
          subscription.unsubscribe();
        };
      };

      if (this.beforeRun) {
        void this.beforeRun(input)
          .then(start)
          .catch((error) => {
            if (!cancelled) observer.error(error);
          });
      } else {
        start();
      }

      return () => {
        cancelled = true;
        detach?.();
      };
    });
  }

  override async runAgent(
    parameters?: RunAgentParameters,
    subscriber?: AgentSubscriber,
  ): Promise<RunAgentResult> {
    /*
     * Carry the conversation inward. `runAgent` builds its model input from
     * the agent it is called on, so a wrapper that holds messages while its
     * inner runs empty bills a turn for a question the model never sees.
     * Only an empty inner is seeded; anything already holding messages was
     * arranged by its builder (a routine's seeded history, a hop's context).
     */
    if (this.inner.messages.length === 0 && this.messages.length > 0) {
      this.inner.setMessages(this.messages);
    }
    /*
     * BEFORE THE METER, AND ON THIS PATH TOO.
     *
     * `beforeRun` was only called from `run`, and this is the path a person's own turn takes — the
     * request path calls `runAgent`. So whatever `beforeRun` is for did not happen on the one path
     * most turns take: the turn-eligibility check a deployment relies on to refuse a turn it will not
     * serve was skipped for every chat message, and would have been spent as though it had not.
     *
     * A no-op when there is no `beforeRun`, and it throws before the meter is attached, so a refused
     * turn is neither billed nor recorded.
     */
    if (this.beforeRun) {
      await this.beforeRun({
        threadId: this.inner.threadId,
        runId: parameters?.runId,
      } as RunAgentInput);
    }
    const { subscriber: metering, settleNow } = this.meterFor({
      threadId: this.inner.threadId,
      // Named on the settlement from here too, so a settled turn can say which run it was. See
      // `TurnSettlement.runId`.
      runId: parameters?.runId,
      messages: this.inner.messages,
    });
    const attached = this.inner.subscribe(metering);
    try {
      return await this.inner.runAgent(parameters, subscriber);
    } finally {
      // Idempotent with onRunFinalized/onRunFailed: whichever fires first
      // settles the turn, so a runner that never emits finalization still
      // gets charged exactly once.
      settleNow();
      attached.unsubscribe();
    }
  }

  override abortRun(): void {
    this.inner.abortRun();
    super.abortRun();
  }

  override clone(): EnforcedAgent {
    const clonedInner = this.inner.clone() as AbstractAgent;
    return new EnforcedAgent(clonedInner, {
      maxToolCalls: this.maxToolCalls,
      getContainerSeconds: this.getContainerSeconds,
      onTurnSettled: this.onTurnSettled,
      /*
       * `beforeRun` too, which it was dropped.
       *
       * The request path clones the agent it is about to run — that is how a run gets its own
       * message list — and a clone without this one arrived already stripped of the check that
       * refuses a turn this deployment will not serve. The same omission as on `runAgent`, and the
       * same fix.
       */
      ...(this.beforeRun ? { beforeRun: this.beforeRun } : {}),
    });
  }

  override async getCapabilities() {
    return this.inner.getCapabilities?.() ?? {};
  }
}
