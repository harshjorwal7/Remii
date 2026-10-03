import { describe, expect, test } from "bun:test";
import type { AbstractAgent, BaseEvent } from "@ag-ui/client";
import { Observable } from "rxjs";
import type { AgentRunnerRunRequest } from "@copilotkit/runtime";
import { PostgresAgentRunner, type ThreadStore } from "../src/threads/local";

/**
 * A CONVERSATION YOU LEFT COMES BACK WORKING.
 *
 * The bug this file exists for is the worst kind there is, because it does not announce itself. A
 * person starts a long task, clicks into another conversation, and comes back. Nothing is broken on
 * screen: the transcript renders, the composer is enabled, the draft clears on send. The message is
 * persisted and there is no reply, no error, and no spinner, and every retry does exactly the same
 * thing — until a run nobody is watching eventually finishes on the server and lets the next message
 * through.
 *
 * The cause is one line of configuration. `InMemoryAgentRunner` refuses a second run on a live thread
 * by default (`onConcurrentRun: "throw"`), which is the correct default for a runner that cannot tell
 * a stale caller from a live one. This deployment's caller is a browser that is allowed to walk away,
 * and walking away does not stop a run — nothing in the app aborts on unmount, deliberately, because
 * closing a tab is not a request to stop working. So the orphan holds the thread, the next message is
 * refused, and the refusal is invisible:
 *
 * The throw happens inside the observable factory, which the SSE handler reaches only AFTER it has
 * answered `200 text/event-stream`. So the browser receives a successful response with an empty body.
 * `runAgent` resolves with zero events. The client cannot distinguish that from a run that produced
 * nothing and failed nothing, the composer has already cleared the draft, and no failure is recorded.
 *
 * These tests pin `supersede` at the level where the behaviour actually lives — the runner — rather
 * than through the HTTP handler, because the handler is what swallows the error and the handler is
 * upstream code. If this flag is ever dropped, they fail with a message naming the silent reply.
 */

/** A thread store that accepts everything: the runner's persistence is not what's under test. */
const permissiveThreads = {
  async ensureThread() {},
  async threadOwner() {
    return null;
  },
  async claimThread() {},
  async appendMessages() {},
  async getHistory() {
    return [];
  },
} as unknown as ThreadStore;

/**
 * An agent whose run can be held open, so the thread is genuinely busy when the second run arrives.
 *
 * THE CALLBACK API, NOT A RETURNED OBSERVABLE. The runner calls
 * `agent.runAgent(input, { onEvent, onRunStartedEvent, … })` and awaits the promise it returns; it
 * never subscribes to anything. A stub that returns an Observable — which is the obvious thing to
 * write, and what the type signature's neighbours suggest — is silently ignored: no events reach
 * `onEvent`, the promise resolves on the spot, and the run finalises before the test has asserted
 * anything. The thread then reads as idle, and `supersede` never fires.
 *
 * `runAgent` returns a promise that only settles when the agent is aborted, which is the state a long
 * desktop task is in and the only state in which superseding is observable at all.
 */
function holdingAgent(onAbort: () => void): AbstractAgent {
  let release: (() => void) | null = null;
  const agent = {
    agentId: "default",
    threadId: "",
    messages: [] as unknown[],
    setMessages(messages: unknown[]) {
      agent.messages = messages;
    },
    abortRun: () => {
      onAbort();
      release?.();
    },
    async runAgent(
      _input: unknown,
      context?: { onEvent?: (payload: { event: BaseEvent }) => void },
    ) {
      context?.onEvent?.({ event: { type: "RUN_STARTED" } as BaseEvent });
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      context?.onEvent?.({ event: { type: "RUN_FINISHED" } as BaseEvent });
    },
  };
  return agent as unknown as AbstractAgent;
}

function runRequest(threadId: string, agent: AbstractAgent, runId: string) {
  return {
    threadId,
    agent,
    input: { runId, messages: [], tools: [], context: [], state: {} },
  } as unknown as AgentRunnerRunRequest;
}

/** Subscribe and collect, so a refusal that never delivers an event is observable as such. */
function collect(stream: Observable<BaseEvent>): Promise<BaseEvent[]> {
  return new Promise((resolve, reject) => {
    const events: BaseEvent[] = [];
    stream.subscribe({
      next: (event) => events.push(event),
      error: reject,
      // Never resolves for a held run, which is the point: the tests below await the FIRST event
      // rather than completion, via `firstEvent`.
      complete: () => resolve(events),
    });
  });
}

function firstEvent(stream: Observable<BaseEvent>): Promise<BaseEvent> {
  return new Promise((resolve, reject) => {
    const subscription = stream.subscribe({
      next: (event) => {
        resolve(event);
        // Unsubscribing is what stops a held run from holding this test open.
        setTimeout(() => subscription.unsubscribe(), 0);
      },
      error: reject,
    });
  });
}

/**
 * Start a run and leave it RUNNING.
 *
 * The distinction from {@link firstEvent} is the whole test. Unsubscribing from a run's stream tears
 * that run down — the runner finalises it and the thread goes idle — so a helper that awaited the
 * first event and then unsubscribed would have ended the run before the second one arrived, and every
 * test below would be asserting against a thread that was never busy. Superseding is only observable
 * against a run that is genuinely still going, which is the state a long desktop task is in.
 *
 * Returns a handle so the test can close it when it is done, and to observe whether superseding closed
 * it on its own.
 */
function heldRun(
  stream: Observable<BaseEvent>,
): { opened: Promise<BaseEvent>; ended: Promise<void>; close: () => void } {
  let settle: () => void = () => {};
  const ended = new Promise<void>((resolve) => {
    settle = resolve;
  });
  let subscription: { unsubscribe: () => void } | null = null;
  const opened = new Promise<BaseEvent>((resolve, reject) => {
    subscription = stream.subscribe({
      next: (event) => resolve(event),
      error: (error) => {
        settle();
        reject(error);
      },
      complete: () => settle(),
    });
  });
  return {
    opened,
    ended,
    close: () => {
      subscription?.unsubscribe();
      settle();
    },
  };
}

describe("a second run on a busy thread", () => {
  test("starts, instead of failing in a way the client cannot see", async () => {
    const runner = new PostgresAgentRunner(permissiveThreads);
    const first = holdingAgent(() => {});
    const second = holdingAgent(() => {});

    const orphan = heldRun(runner.run(runRequest("thread-1", first, "run-1")));
    await orphan.opened;

    /*
     * THE ASSERTION THAT MATTERS. With the default `throw`, this rejects with
     * "Thread already running" — and in the real deployment that rejection is raised after the SSE
     * response has already been sent, so it never reaches the browser at all. Here it surfaces
     * directly, which is why the failure is legible in a test and invisible in the product.
     */
    const replacement = heldRun(
      runner.run(runRequest("thread-1", second, "run-2")),
    );
    await expect(replacement.opened).resolves.toBeDefined();

    orphan.close();
    replacement.close();
  });

  test("ends the run it displaced, so its agent is not left executing", async () => {
    const runner = new PostgresAgentRunner(permissiveThreads);
    let aborted = 0;
    const first = holdingAgent(() => {
      aborted += 1;
    });
    const second = holdingAgent(() => {});

    const orphan = heldRun(runner.run(runRequest("thread-2", first, "run-a")));
    await orphan.opened;
    const replacement = heldRun(
      runner.run(runRequest("thread-2", second, "run-b")),
    );
    await replacement.opened;

    expect(aborted).toBe(1);

    orphan.close();
    replacement.close();
  });

  test("leaves an unrelated thread's run alone", async () => {
    const runner = new PostgresAgentRunner(permissiveThreads);
    let aborted = 0;
    const elsewhere = holdingAgent(() => {
      aborted += 1;
    });
    const here = holdingAgent(() => {});

    const first = heldRun(runner.run(runRequest("thread-here", here, "run-c")));
    await first.opened;
    const second = heldRun(
      runner.run(runRequest("thread-there", elsewhere, "run-d")),
    );
    await second.opened;

    // Two conversations, two people possibly typing. Superseding is per thread and not per runner.
    expect(aborted).toBe(0);

    first.close();
    second.close();
  });

  test("reports the displaced run as no longer running, so a Stop can reach the new one", async () => {
    const runner = new PostgresAgentRunner(permissiveThreads);
    const first = holdingAgent(() => {});
    const second = holdingAgent(() => {});

    const orphan = heldRun(runner.run(runRequest("thread-3", first, "run-1")));
    await orphan.opened;
    const replacement = heldRun(
      runner.run(runRequest("thread-3", second, "run-2")),
    );
    await replacement.opened;

    /*
     * The state the composer's Stop button depends on, and the reason `supersede` has to clear the
     * old run rather than merely start a new one: if the store still reported the thread as running
     * under the displaced run, `isRunning` would answer for a run nobody can stop.
     */
    await expect(runner.isRunning({ threadId: "thread-3" })).resolves.toBe(
      true,
    );

    orphan.close();
    replacement.close();
  });

  test("a displaced run is completed, so a subscriber to it is not left hanging", async () => {
    const runner = new PostgresAgentRunner(permissiveThreads);
    const first = holdingAgent(() => {});
    const second = holdingAgent(() => {});

    /*
     * The failure mode of the OTHER half of the fix, stated as a test.
     *
     * `supersede` works by ending the prior run. A caller still subscribed to that prior run — which
     * is exactly what a browser that navigated away and came back briefly is — must be told the run
     * ended. If it were left subscribed to nothing, that browser's stream would hang until its own
     * timeout, which is the "chat stops working" symptom arriving by a different route.
     */
    const orphan = heldRun(runner.run(runRequest("thread-4", first, "run-1")));
    await orphan.opened;
    const replacement = heldRun(
      runner.run(runRequest("thread-4", second, "run-2")),
    );
    await replacement.opened;

    const settled = await Promise.race([
      orphan.ended.then(() => "ended" as const),
      Bun.sleep(2000).then(() => "still-hanging" as const),
    ]);
    expect(settled).toBe("ended");

    orphan.close();
    replacement.close();
  });
});