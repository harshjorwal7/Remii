import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, waitFor } from "@testing-library/react";
import { RoutinesList } from "@/components/routines/routines-list";
import { FATIGUE_THRESHOLD, type RoutineRecord } from "@/lib/routines/queries";

/**
 * The routines list, rendered for real rather than asserted through a predicate.
 *
 * The failure streak is the reason this file exists: it is the one thing on the page that tells a
 * person their standing work is heading for being switched off, and it arrived on the DTO with no
 * component ever reading it — the field existed at every layer and rendered nowhere, which is the
 * shape of a feature that looks finished in review and tells a person nothing.
 */

function renderList() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const rootRoute = createRootRoute({
    component: () => (
      <QueryClientProvider client={queryClient}>
        <RoutinesList />
      </QueryClientProvider>
    ),
  });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return render(<RouterProvider router={router} />);
}

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function routine(overrides: Partial<RoutineRecord> = {}): RoutineRecord {
  return {
    id: "routine-1",
    agentId: "agent-1",
    schedule: "Weekdays at 09:00",
    timezone: "UTC",
    instruction: "Post the standup notes.",
    channel: { id: "channel-1", name: "Standup", gone: false },
    enabled: true,
    nextRunAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    lastRun: null,
    consecutiveFailures: 0,
    ...overrides,
  };
}

/** Answers the one endpoint the list reads. */
function serve(routines: RoutineRecord[]) {
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        routines,
        // Working, so the "nothing is running these" banner stays out of these assertions.
        sweep: { lastSweptAt: new Date().toISOString(), working: true },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as unknown as typeof fetch;
}

test("says nothing about failures when there are none", async () => {
  serve([routine()]);
  const view = renderList();

  await waitFor(() => {
    expect(view.getByText("Post the standup notes.")).toBeTruthy();
  });
  expect(view.queryByText(/Failed \d/)).toBeNull();
});

test("warns that a failing routine is heading for being switched off", async () => {
  serve([routine({ consecutiveFailures: 3 })]);
  const view = renderList();

  // The wording carries the count, because "something is wrong" does not tell a person whether
  // they have time to fix it before it stops on its own.
  await waitFor(() => {
    expect(view.getByText("Failed 3× running")).toBeTruthy();
  });
});

test("says switching off at the threshold rather than a bigger number", async () => {
  serve([routine({ consecutiveFailures: FATIGUE_THRESHOLD })]);
  const view = renderList();

  await waitFor(() => {
    expect(
      view.getByText(`Failed ${FATIGUE_THRESHOLD} times — switching off`),
    ).toBeTruthy();
  });
});

/*
 * A streak on a routine that has already been switched off reports a climb that stopped, so it is
 * hidden. Without this the page would say "Failed 10× running" beside a routine that is not running.
 */
test("hides the streak on a routine the fatigue rule already switched off", async () => {
  serve([routine({ enabled: false, consecutiveFailures: FATIGUE_THRESHOLD })]);
  const view = renderList();

  await waitFor(() => {
    expect(view.getByText("Post the standup notes.")).toBeTruthy();
  });
  expect(view.queryByText(/Failed \d/)).toBeNull();
});
