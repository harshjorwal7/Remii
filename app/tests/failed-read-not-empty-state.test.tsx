import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, waitFor } from "@testing-library/react";
import { Route as BillingRoute } from "@/routes/_authed/settings/billing";

/**
 * "YOU HAVE NOTHING" AND "WE COULD NOT ASK" ARE DIFFERENT SENTENCES.
 *
 * A query that fails and a query that returns nothing both leave `isPending` false. That is the
 * whole bug, and it is not subtle once stated: a screen that branches on `isPending` alone draws its
 * EMPTY state on a FAILED read, and tells a person with twenty coworkers, a paid plan, or a written
 * skill that they have none.
 *
 * `agent-roster-error.test.tsx` established the rule and the fix shape for the two agent screens.
 * These are the screens that had not been given it, and two of them are worse than an empty list:
 *
 *   - Billing drew a **free plan** — no trial, "0 of 0 used", and an "Upgrade to Pro · $49/mo"
 *     button — for a paying customer whose own request had just failed. They could buy the plan
 *     they already had, and the usage numbers were invented rather than merely missing.
 *   - Boundaries then used the same defaulted tier to put a paywall in front of settings the account
 *     owns, and disagreed with Billing about which tiers count as paid.
 *
 * SCOPE, STATED PLAINLY. This file drives the Billing screen end to end, which is the worst of them:
 * it is the one that offers money to somebody for a plan they already hold. The same rule is applied
 * in `skills.tsx`, `agent-connections.tsx` and `app-sidebar.tsx`, and those three are NOT covered
 * here — the skills route renders nothing at all when this file runs after others in the same bun
 * process, and a test that depends on file order is worse than no test. They are fixed and
 * typechecked; a route-level test for each is still owed.
 *
 * The harness is this repository's, for the reason recorded in `agent-roster-error.test.tsx`: bun
 * walks every file into one process and a document another file tore down mid-run fails silently.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

/** A query that fails once, with retries off, the way the app's own client would see it. */
/**
 * EVERY read fails, not just the one under test.
 *
 * This started as a selective mock that delegated everything else to whatever `global.fetch` it
 * found, and it passed alone and failed in the full run — because bun runs every file in one
 * process, and by then some other file's mock owned `/api/me`. A read that never settles keeps
 * `isPending` true forever, so the screen drew a skeleton and the assertion failed for a reason that
 * had nothing to do with the bug.
 *
 * Failing everything is both simpler and honest: it is what a deployment with a broken upstream
 * actually looks like, and it makes the test independent of whatever ran before it. This is the same
 * choice `agent-roster-error.test.tsx` records.
 */
const renderRoute = async (FileRoute: unknown) => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(null, { status: 500 })) as unknown as typeof fetch;

  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const route = createRoute({
    getParentRoute: () => rootRoute,
    path: "/screen",
    /*
     * `createFileRoute` keeps the component under `options`, not on the route itself. Reading
     * `Route.component` yields `undefined`, which renders an empty div and makes every assertion
     * below pass or fail for the wrong reason.
     */
    component: (
      FileRoute as { options: { component: () => React.ReactElement } }
    ).options.component,
  });
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/screen"] }),
    routeTree: rootRoute.addChildren([route]),
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return {
    view,
    restore: () => {
      globalThis.fetch = original;
    },
  };
};

describe("a failed billing read is not a free account", () => {
  test("does not offer the upgrade to somebody whose plan could not be read", async () => {
    const { view, restore } = await renderRoute(BillingRoute as never);
    try {
      await waitFor(() => {
        expect(view.baseElement.textContent ?? "").toMatch(
          /could not be loaded/i,
        );
      });
      const text = view.baseElement.textContent ?? "";
      // The three claims a defaulted "free" account makes, none of which may be made.
      expect(text).not.toMatch(/Upgrade to Pro/i);
      expect(text).not.toMatch(/\$49/);
      expect(text).not.toMatch(/0 of 0 used/i);
    } finally {
      restore();
    }
  });

  test("says plainly that nothing was changed", async () => {
    const { view, restore } = await renderRoute(BillingRoute as never);
    try {
      await waitFor(() => {
        expect(view.baseElement.textContent ?? "").toMatch(
          /Nothing has been changed/i,
        );
      });
    } finally {
      restore();
    }
  });
});
