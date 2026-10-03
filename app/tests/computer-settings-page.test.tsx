import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
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
import { Route as ComputerSettingsRoute } from "@/routes/_authed/settings/computer";

/**
 * The Computer page in Settings, rendered.
 *
 * This page used to draw a computer per Bot, from an endpoint reading a table nothing has written
 * since the per-Bot provisioner was removed — so it listed machines that did not exist, never showed
 * the one that did, and called every Bot "asleep" because it asked for a `running` flag the endpoint
 * has never sent. None of that is visible to a test that only checks the component returns something,
 * which is why it is rendered here through its real, exported Route.
 *
 * The three states below are the ones that must not be confused for one another. A person with no
 * desktop yet, a person whose desktop could not be asked about, and a person with a machine asleep
 * are three different facts, and the page used to have an empty state standing in for all three —
 * which reports a healthy deployment with nothing on it precisely when something is wrong.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

const originalFetch = global.fetch;
let status = 200;
let body: unknown = null;

beforeEach(() => {
  status = 200;
  body = null;
  /*
   * Every read in this app goes through `client()` in `lib/client.ts`, which throws once the response
   * is not `ok` — so a 503 has to be a real `Response`, not an exception, for the page's own error
   * branch to be the thing under test.
   */
  global.fetch = (async (input: unknown) => {
    const url = String(input);
    if (url.includes("/api/computers/desktop/state")) {
      return body === null
        ? new Response(null, { status })
        : new Response(JSON.stringify(body), {
            status,
            headers: { "content-type": "application/json" },
          });
    }
    // The tile's own poll. A 1x1 PNG, so the card has a frame and is not busy saying it has none.
    if (url.includes("/screenshot")) {
      return new Response(
        JSON.stringify({
          base64:
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
          url: "",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(JSON.stringify({ holder: null }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  global.fetch = originalFetch;
});

function renderComputerSettings() {
  const rootRoute = createRootRoute({ component: Outlet });
  const settingsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/settings",
    component: Outlet,
  });
  const computerRoute = createRoute({
    getParentRoute: () => settingsRoute,
    path: "computer",
    component: ComputerSettingsRoute.options.component,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      settingsRoute.addChildren([computerRoute]),
    ]),
    history: createMemoryHistory({ initialEntries: ["/settings/computer"] }),
  });
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

/** A row the server really sends for a desktop that exists. */
const runningDesktop = {
  computer: {
    status: "RUNNING",
    displayWidth: 1920,
    displayHeight: 1080,
    lastSeenAt: new Date().toISOString(),
  },
  hoursUsed: 1.5,
  hoursIncluded: 30,
  isolation: "per-person" as const,
};

test("one desktop is shown, with what a person came to ask about", async () => {
  body = runningDesktop;
  const view = renderComputerSettings();

  expect(await view.findByText("Awake")).toBeTruthy();
  // The allowance is spent in the unit it is spent in, not as a percentage.
  expect(
    view.getByText(/28h 30m of computer time left this month/),
  ).toBeTruthy();
  expect(view.getByText("Last used just now")).toBeTruthy();
  expect(view.getByText("1920×1080")).toBeTruthy();
  // One screen, labelled with the name Remii goes by.
  expect(view.getAllByText("Remii")).toHaveLength(1);
});

test("a desktop that is off says asleep, and still says how much time is left", async () => {
  body = {
    ...runningDesktop,
    computer: { ...runningDesktop.computer, status: "STOPPED" },
  };
  const view = renderComputerSettings();

  expect(await view.findByText("Asleep")).toBeTruthy();
  // The hours do not vanish with the machine: the month's allowance is the same either way, and
  // this page exists to answer "how much is left" as much as "is it up".
  expect(
    view.getByText(/28h 30m of computer time left this month/),
  ).toBeTruthy();
});

test("a person who has never needed a desktop is told that, and not that something broke", async () => {
  // The ordinary state for somebody who has not asked Remii for a screen: no row, no machine, and no
  // cost. Not an error, and nothing to retry.
  body = { computer: null, reason: "no-computer-yet" };
  const view = renderComputerSettings();

  expect(
    await view.findByText(/Remii has not needed a computer yet/),
  ).toBeTruthy();
  expect(view.queryByText("Awake")).toBeNull();
  expect(view.queryByText("Asleep")).toBeNull();
  // An empty state here would report a healthy deployment with no computer on it.
  expect(view.queryByText(/could not be read/)).toBeNull();
});

test("a desktop that cannot be asked about says so, and does not claim there is none", async () => {
  status = 503;
  const view = renderComputerSettings();

  /*
   * THE TWO STATES THAT MUST NOT BE MERGED.
   *
   * "You have no computer" and "we could not reach your computer" are opposite answers, and a person
   * reading the first will wait for something that is already running. This page had an empty state
   * standing in for both.
   */
  expect(await view.findByText(/Your computer could not be read/)).toBeTruthy();
  expect(view.queryByText(/has not needed a computer yet/)).toBeNull();
});

test("a desktop with no hours recorded yet still reports the month's allowance", async () => {
  // The server omits the hours alongside a computer only when there is none, but a row written by an
  // older build carries none either. Falling back to zero would print "0m left" for a plan that
  // includes thirty hours, which is the one number on this page a person acts on — so the fallback
  // has to be the plan's own figure, which is also what the server falls back to.
  body = { computer: runningDesktop.computer, isolation: "per-person" };
  const view = renderComputerSettings();

  expect(
    await view.findByText(/30h 0m of computer time left this month/),
  ).toBeTruthy();
});

test("nothing on this page names a computer per Bot", async () => {
  body = runningDesktop;
  const view = renderComputerSettings();

  /*
   * ONE screen, because there is one machine. The desktop allows a single viewer, and `LiveScreen`
   * opens its socket as soon as it mounts — so a tile per Bot opened a socket per Bot and each one
   * evicted the last. This is the assertion that the fleet does not come back.
   */
  await waitFor(() => expect(view.getByText("Awake")).toBeTruthy());
  expect(view.container.querySelectorAll("figure")).toHaveLength(1);
});
