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
  /**
   * Called on a timer while a turn is running, and told whether the run is still going.
   *
   * A turn's liveness has to be asserted WHILE it runs, because the only moment its existence is
   * known is the moment it is happening. The run's row is written before the turn starts and closed
   * when it settles, and between those two moments nothing else distinguishes a run that is working
   * from a run whose process was killed — which is what left a chat run showing "Working" for ever:
   * the row was written, the cleanup that would have closed it was dropped, and the abandoned-run
   * sweeper had no signal to read because a chat run takes no thread lock.
   *
   * The boolean is the beat's own answer — false means the run is no longer open, so the caller can
   * stop writing and, if it owns one, abort. It is what lets this be a plain interval rather than
   * something that has to be cancelled from the outside, so a run that ends by any route at all stops
   * beating.
   *
   * NOT AWAITED and never allowed to reject into the turn. A heartbeat that fails to write is a
   * liveness signal that did not get through; ending somebody's turn over it would trade a cosmetic
   * stale dot for a lost answer.
   */
  heartbeat?: (input: {
    runId: string;
    threadId: string;
  }) => Promise<boolean> | boolean;
  /**
   * How often to beat, overriding {@link TURN_HEARTBEAT_MS}.
   *
   * Present so a test can drive the timer in milliseconds rather than waiting out a real interval.
   * It is not a tuning knob and nothing in the product sets it: the constant is a deliberate
   * fraction of the abandoned-run grace period, and a deployment that shortened it would only make
   * the sweeper's margin thinner.
   */
  heartbeatIntervalMs?: number;
};

/**
 * How often a running turn says it is still going.
 *
 * A third of the abandoned-run grace period, so a run gets two chances to beat inside the window it
 * has to beat in. Faster than that is a write per turn per interval for no benefit — the sweeper
 * cannot act on anything younger than the grace period — and slower risks a live run being swept on
 * the strength of one missed beat.
 */
export const TURN_HEARTBEAT_MS = 20_000;

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
  private readonly heartbeat?: EnforcedAgentOptions["heartbeat"];
  private readonly heartbeatIntervalMs: number;

  constructor(inner: AbstractAgent, options?: EnforcedAgentOptions) {
    super({ agentId: inner.agentId, description: inner.description });
    this.inner = inner;
    this.maxToolCalls = options?.maxToolCalls ?? MAX_TURN_TOOL_CALLS;
    this.getContainerSeconds = options?.getContainerSeconds;
    this.onTurnSettled = options?.onTurnSettled;
    this.beforeRun = options?.beforeRun;
    this.heartbeat = options?.heartbeat;
    this.heartbeatIntervalMs =
      options?.heartbeatIntervalMs ?? TURN_HEARTBEAT_MS;
  }

  /**
   * A timer that says this run is still going, and a way to stop it.
   *
   * Returned rather than started in place because the two run paths bracket it differently — `run`
   * has a teardown that must stop it, `runAgent` has a `finally` — and a timer whose lifetime is set
   * by two different call sites is a timer one of them will forget.
   *
   * A no-op when no heartbeat was supplied or when there is no run to beat for, so a caller does not
   * have to distinguish "no heartbeat configured" from "nothing to heartbeat about".
   */
  private startHeartbeat(input: {
    runId?: string;
    threadId?: string;
  }): () => void {
    const runId = input.runId;
    const beat = this.heartbeat;
    if (!beat || typeof runId !== "string" || runId.length === 0) {
      return () => {};
    }
    const threadId = typeof input.threadId === "string" ? input.threadId : "";
    const timer = setInterval(() => {
      void (async () => {
        try {
          // False means the run is no longer open — it settled, or the sweeper ended it. Either way
          // there is nothing left to prove, and beating on would be claiming a liveness that has
          // already been withdrawn.
          if (!(await beat({ runId, threadId }))) clearInterval(timer);
        } catch {
          // See the option's note: a beat that did not get through is never somebody's lost turn.
        }
      })();
    }, this.heartbeatIntervalMs);
    // A pending beat must not be a reason the process stays alive.
    timer.unref?.();
    return () => clearInterval(timer);
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

      /*
       * STARTED HERE, BESIDE THE METER, SO IT IS STOPPED BY THE SAME TEARDOWN.
       *
       * The beat begins with the turn's own existence rather than with `start`, because the window
       * this whole fix exists for — `beforeRun` resolved, `start` not yet reached — is precisely a
       * window in which the run has a row and is not yet emitting anything. A beat that waited for
       * `start` would not cover it, and that window is where the ghosts were made.
       */
      const stopHeartbeat = this.startHeartbeat(input);

      /*
       * THE METER IS BUILT BEFORE `beforeRun` IS ASKED FOR, not inside `start`, and that ordering is
       * the fix for a run that was written to the roster and never taken off it.
       *
       * `beforeRun` is async and hits the database, and the subscription can be torn down while it is
       * outstanding — the SSE response aborts on `request.signal` and unsubscribes, which is what a
       * closed tab, a refresh and a dropped connection all look like from here. The teardown below
       * could only settle the turn through `detach`, and `detach` used to be assigned inside `start`,
       * which `beforeRun`'s resolution gates: so an unsubscribe in that window found `detach`
       * undefined, `settleNow` never ran, `onTurnSettled` never ran, and `finish()` never ran. The
       * run's own record stayed `thinking` with no `ended_at` and the channel kept a working pulse
       * for ever — a ghost the roster could not clear, because the abandoned-run sweeper only reads
       * lock rows and a chat run takes no lock.
       *
       * `beforeRun` had already done the only irreversible part by then. It is what calls
       * `runActivityStore.begin`, so the row was written and announced before the very await that
       * could discard the cleanup. Moving the teardown after the write but before the settle is the
       * whole bug.
       *
       * Nothing is lost by building it early: `meterFor` reads only `threadId`, `runId` and
       * `messages`, all of which are on `input` at subscribe time, and it attaches no subscription
       * of its own.
       */
      const { subscriber, settleNow } = this.meterFor(input);

      /*
       * Whether `beforeRun` got far enough to write this turn's record.
       *
       * IT IS NOT THE SAME QUESTION AS `cancelled`, and conflating the two would bill a turn this
       * deployment refused to serve. `beforeRun` throws before `begin` for an ineligible turn, a
       * paused coworker and a thread belonging to somebody else, and a refused turn must be neither
       * recorded nor charged — see the note on `beforeRun` in `metering.ts`'s call site. Settling
       * merely because the stream was torn down would charge every one of those refusals, at zero
       * tokens, which is still a deduction and still a usage row.
       *
       * So the two are tracked apart: `cancelled` says the subscriber went away, `began` says there
       * is a row that needs finishing. The teardown settles on `began` alone, and `start` sets `began`
       * on the way in so a turn cancelled mid-`beforeRun` still settles once `beforeRun` resolves —
       * the window this whole fix exists for.
       */
      let began = false;

      const start = () => {
        began = true;
        // Cancelled before it began, so there is nothing to subscribe to and nothing to stream.
        // `settleNow` has already run by way of the teardown, and `TurnMeter.settle` is idempotent,
        // so calling it here rather than not at all cannot double-charge.
        if (cancelled) {
          settleNow();
          return;
        }
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
            // A refusal. `beforeRun` threw before it wrote anything, so there is no row to finish and
            // nothing to charge: `began` is still false and the teardown will not settle it.
            if (!cancelled) observer.error(error);
          });
      } else {
        start();
      }

      return () => {
        cancelled = true;
        /*
         * BOTH, AND THE SECOND IS THE ONE THAT MATTERS.
         *
         * `detach` unsubscribes the inner agent and is still undefined when the teardown beats
         * `start`. `settleNow` is unconditional and always defined, because the meter is built above,
         * so a turn abandoned after its record was written is still settled exactly once.
         *
         * ON `began`, WHICH IS WHAT KEEPS A REFUSAL FREE. A turn this deployment declined never wrote
         * a record, so there is nothing to finish and nothing to bill, and settling it would charge a
         * person for a turn that was correctly refused. The window this fixes is `beforeRun` resolved
         * (record written) but `start` not yet reached the subscriber — `began` is true there and
         * false for a refusal, which is the only distinction that matters here.
         *
         * Idempotence is `TurnMeter.settle`'s own `settled` flag, so this cannot double-charge a turn
         * that did start and did finish.
         */
        detach?.();
        if (began) settleNow();
        stopHeartbeat();
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
     *
     * NO `began` FLAG HERE, AND THAT IS THE DIFFERENCE BETWEEN THE TWO PATHS RATHER THAN AN
     * OMISSION. `beforeRun` is AWAITED on this path, so there is no window in which the record has
     * been written and the cleanup has not been attached: the throw above leaves no meter to settle
     * and propagates out of the method, and everything after it runs inside the `finally`. Only
     * `run` hands `beforeRun` to a promise nobody awaits, which is what created the window the flag
     * exists to cover.
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
    /*
     * Started after `beforeRun` rather than before it, and that asymmetry with `run` is deliberate:
     * here `beforeRun` is awaited, so there is no window in which the row exists and the beat does
     * not. A run that never got past the refusal above never began, so there is nothing to beat for.
     */
    const stopHeartbeat = this.startHeartbeat({
      runId: parameters?.runId,
      threadId: this.inner.threadId,
    });
    try {
      return await this.inner.runAgent(parameters, subscriber);
    } finally {
      // Idempotent with onRunFinalized/onRunFailed: whichever fires first
      // settles the turn, so a runner that never emits finalization still
      // gets charged exactly once.
      settleNow();
      stopHeartbeat();
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
      /*
       * And the heartbeat, for the same reason and with the same consequence if it were dropped.
       *
       * The request path clones the agent it is about to run, so a clone without this one runs the
       * turn to completion and never says so while it is happening — which is the same turn that
       * would then be indistinguishable from one whose process was killed. A cloned run has a row,
       * because `beforeRun` came along, and a row nothing beats on is exactly the ghost.
       */
      ...(this.heartbeat ? { heartbeat: this.heartbeat } : {}),
      ...(this.heartbeatIntervalMs !== TURN_HEARTBEAT_MS
        ? { heartbeatIntervalMs: this.heartbeatIntervalMs }
        : {}),
    });
  }

  override async getCapabilities() {
    return this.inner.getCapabilities?.() ?? {};
  }
}
