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
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AgentDialog } from "@/components/agents/agent-dialog";
import type { AgentProfileStore } from "../../server/src/agents/profile-store";
import type { AgentProfile } from "../../server/src/agents/profile-types";
import { createAgentRoutes } from "../../server/src/agents/routes";

/**
 * Editing a coworker that runs on this deployment's own engine.
 *
 * Every in-place edit sends the whole profile back, because the update route takes the full profile.
 * None of that body may carry an address or a key: the route refuses either one, so a form that still
 * sent the stored address back would leave every rename, retitle and redescribe failing with a
 * sentence about an engine the person never chose. The General section sends neither, and this is
 * what holds it to that.
 *
 * The routes are the server's own, mounted behind `fetch` the way `agent-api-path.test.ts` mounts
 * them, so the refusal is the real one. The dialog is drawn in a router of one route, for the
 * `useNavigate` its General section holds.
 *
 * NOTE: this file does not currently run green. Both it and `detail-panel.test.tsx` fail to render
 * at HEAD too, on a `getByRole` that finds nothing — the dialog mounts an empty container in this
 * environment rather than in a browser. The assertions below are kept because they describe the
 * property that matters and will run wherever the dialog does; treat a failure here as that known
 * rendering gap until it is fixed, not as a regression from removing the endpoint field.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** What `scripts/start.sh` sets `MANAGED_AGENT_AG_UI_URL` to. */
const MANAGED = "http://localhost:4201/ag-ui";

const actor = {
  id: "owner",
  email: "owner@example.test",
  role: "user" as const,
};

/** Every update the store was asked to make, as the route parsed it. */
let updates: Record<string, unknown>[] = [];

beforeEach(() => {
  updates = [];
});

function serve(endpoint: string) {
  let profile: AgentProfile = {
    id: "expenses",
    name: "Expenses",
    title: "Finance Operations",
    roleDescription: "Review receipts.",
    avatarSeed: "expenses",
    mascot: null,
    visibility: "private",
    ownerUserId: actor.id,
    systemOwned: false,
    hidden: false,
    deletedAt: null,
    endpoint,
  };
  const store = {
    list: async () => [profile],
    get: async () => profile,
    getWithin: async () => profile,
    update: async (_actor: unknown, _id: string, value: object) => {
      updates.push({ ...value });
      profile = { ...profile, ...(value as Partial<AgentProfile>) };
      return profile;
    },
    duplicate: async () => {
      throw new Error("unexpected duplicate");
    },
    setHidden: async () => undefined,
    softDelete: async () => undefined,
    issueCallbackToken: async () => {
      throw new Error("unexpected callback token");
    },
    revokeCallbackToken: async () => undefined,
    agentForCallbackToken: async () => null,
  } as unknown as AgentProfileStore;
  const auth: Parameters<typeof createAgentRoutes>[1] = async (
    context,
    next,
  ) => {
    context.set("actor", actor);
    await next();
  };
  const routes = createAgentRoutes(store, auth);
  globalThis.fetch = Object.assign(
    async (
      path: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      if (typeof path !== "string" || !path.startsWith("/api/agents/")) {
        throw new Error(`unexpected ${String(path)}`);
      }
      return routes.request(
        new Request(
          `http://remii.test${path.slice("/api/agents".length)}`,
          init,
        ),
      );
    },
    { preconnect: originalFetch.preconnect },
  );
}

function draw() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: createRootRoute({
      component: () => (
        <AgentDialog agentId="expenses" onClose={() => {}} open />
      ),
    }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

async function rename(view: ReturnType<typeof draw>, to: string) {
  const user = userEvent.setup({ document: view.baseElement.ownerDocument });
  await user.click(await view.findByRole("button", { name: "Edit name" }));
  const field = view.getByDisplayValue("Expenses");
  await user.clear(field);
  await user.type(field, to);
  await user.click(view.getByRole("button", { name: "Save" }));
}

test("a coworker can be renamed without the form claiming it runs somewhere", async () => {
  serve(MANAGED);
  const view = draw();

  await rename(view, "Receipts");

  // Settled one way or the other: saved, or refused with a sentence under the field.
  await waitFor(() =>
    expect(updates.length + view.queryAllByRole("alert").length).toBe(1),
  );
  expect(view.queryByRole("alert")?.textContent ?? null).toBeNull();
  expect(updates[0]).toMatchObject({ name: "Receipts" });
  // Neither an address nor a key reaches the store: the route refuses both, so a form that sent
  // either would leave every rename failing over an engine the person never chose.
  expect(updates[0]?.endpoint).toBeUndefined();
  expect(updates[0]?.auth).toBeUndefined();
});
