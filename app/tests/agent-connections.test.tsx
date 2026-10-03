import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConnectionSection } from "@/components/agents/agent-connections";
import type { AgentProfile } from "@/lib/agents/queries";

function renderWithRouter(queryClient: QueryClient) {
  const rootRoute = createRootRoute({
    component: () => (
      <QueryClientProvider client={queryClient}>
        <ConnectionSection agentId="agent-1" profile={profile} />
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

const profile: AgentProfile = {
  id: "agent-1",
  name: "General Assistant",
  title: "Everyday Work",
  roleDescription: "Does everyday things.",
  avatarSeed: "seed",
  mascot: null,
  visibility: "private",
  canManage: true,
  hidden: false,
  systemOwned: false,
  mine: true,
};

function setupFetch(grants: string[] = ["composio-slack/slack_post_message"]) {
  const requests: { url: string; method?: string; body?: unknown }[] = [];

  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ url, method, body });

    if (url.includes("/api/plugins?slim=1")) {
      return new Response(
        JSON.stringify({
          catalogue: [],
          servers: [
            {
              id: "composio-slack",
              title: "Slack",
              vendor: "Slack",
              url: "composio://slack",
              summary: "Team messaging and collaboration.",
              docsUrl: "",
              provenance: "composio",
              hasCredential: true,
              toolsRefreshedAt: null,
              lastError: null,
              addedBy: null,
              dynamicClient: false,
              authScheme: "OAUTH2",
              broker: {
                logo: null,
                description: "Team messaging and collaboration.",
                categories: ["productivity", "communication"],
                actionCount: 167,
              },
              tools: [],
              withdrawn: [],
            },
            {
              id: "composio-gmail",
              title: "Gmail",
              vendor: "Google",
              url: "composio://gmail",
              summary: "Email threads and messages.",
              docsUrl: "",
              provenance: "composio",
              hasCredential: true,
              toolsRefreshedAt: null,
              lastError: null,
              addedBy: null,
              dynamicClient: false,
              authScheme: "OAUTH2",
              broker: {
                logo: null,
                description: "Email threads and messages.",
                categories: ["productivity", "google"],
                actionCount: 42,
              },
              tools: [],
              withdrawn: [],
            },
          ],
          skills: [],
          botsMayCallBack: true,
          redirectUri: null,
          composioConfigured: true,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    if (url.includes("/api/plugins/for/agent-1")) {
      return new Response(
        JSON.stringify({
          tools: grants.map((ref) => ({
            ref,
            toolName: ref.split("/")[1] ?? ref,
            description: "Sample tool",
            inputSchema: {},
          })),
          skills: [],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    if (url.includes("/api/plugins/connections")) {
      return new Response(
        JSON.stringify({
          connections: [
            {
              serverId: "composio-slack",
              scope: "",
              connectedAt: new Date().toISOString(),
            },
            {
              serverId: "composio-gmail",
              scope: "",
              connectedAt: new Date().toISOString(),
            },
          ],
          redirectUri: null,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    if (url.includes("/grant")) {
      return new Response(
        JSON.stringify({ ok: true, count: 10, granted: body?.granted ?? true }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    return new Response(JSON.stringify({}), { status: 200 });
  }) as unknown as typeof fetch;

  return requests;
}

test("renders available apps with their Allowed and Dismissed status", async () => {
  setupFetch(["composio-slack/slack_post_message"]);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  const view = renderWithRouter(queryClient);

  // Both Slack and Gmail should appear in the list
  await waitFor(() => {
    expect(view.getByText("Slack")).toBeTruthy();
    expect(view.getByText("Gmail")).toBeTruthy();
  });

  // Slack is granted, so it should have a Dismiss button
  expect(view.getByRole("button", { name: "Dismiss" })).toBeTruthy();

  // Gmail is not granted, so it should have an Allow button
  expect(view.getByRole("button", { name: "Allow" })).toBeTruthy();
});

test("clicking Allow on a dismissed app calls the server grant endpoint", async () => {
  const requests = setupFetch(["composio-slack/slack_post_message"]);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  const view = renderWithRouter(queryClient);

  await waitFor(() => {
    expect(view.getByText("Gmail")).toBeTruthy();
  });

  const allowButton = view.getByRole("button", { name: "Allow" });
  fireEvent.click(allowButton);

  await waitFor(() => {
    const grantCall = requests.find((r) =>
      r.url.includes("/api/plugins/servers/composio-gmail/grant"),
    );
    expect(grantCall).toBeTruthy();
    expect(grantCall?.method).toBe("POST");
    expect(grantCall?.body).toEqual({ agentId: "agent-1", granted: true });
  });
});

test("clicking Dismiss on an allowed app calls the server revoke endpoint", async () => {
  const requests = setupFetch(["composio-slack/slack_post_message"]);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  const view = renderWithRouter(queryClient);

  await waitFor(() => {
    expect(view.getByText("Slack")).toBeTruthy();
  });

  const dismissButton = view.getByRole("button", { name: "Dismiss" });
  fireEvent.click(dismissButton);

  await waitFor(() => {
    const grantCall = requests.find((r) =>
      r.url.includes("/api/plugins/servers/composio-slack/grant"),
    );
    expect(grantCall).toBeTruthy();
    expect(grantCall?.method).toBe("POST");
    expect(grantCall?.body).toEqual({ agentId: "agent-1", granted: false });
  });
});

test("typing in search filters the apps list", async () => {
  setupFetch(["composio-slack/slack_post_message"]);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  const view = renderWithRouter(queryClient);

  await waitFor(() => {
    expect(view.getByText("Slack")).toBeTruthy();
    expect(view.getByText("Gmail")).toBeTruthy();
  });

  const user = userEvent.setup({ document: view.baseElement.ownerDocument });
  const searchInput = view.getByLabelText("Search apps");
  await user.type(searchInput, "gmail");

  await waitFor(() => {
    expect(view.queryByText("Slack")).toBeNull();
    expect(view.getByText("Gmail")).toBeTruthy();
  });
});
