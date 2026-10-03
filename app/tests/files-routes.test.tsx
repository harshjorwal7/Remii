import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRouter, RouterProvider } from "@tanstack/react-router";
import { cleanup, render, waitFor } from "@testing-library/react";
import { routeTree } from "../src/routeTree.gen";

/**
 * A saved file opens, and its text is on the page.
 *
 * THE ROUTING SHAPE IS THE WHOLE POINT. The list and the file's own page were
 * written as `files.tsx` and `files/$id.tsx` — a flat file beside a directory
 * of the same name. That makes the flat file a LAYOUT route with the detail
 * route as its child, and a layout renders its own component: the list showed
 * at `/settings/files/<id>` as well, the child had nowhere to mount, and
 * clicking a file changed the URL without changing anything on screen. Every
 * layer above it was provably fine — the endpoint answered 200 with the file's
 * text, the route was registered, the module loaded — which is why it read as
 * "the preview is broken" rather than "the page is not being rendered".
 *
 * The shape every other list-and-detail pair in these settings uses is a
 * directory with `index.tsx` and `$param.tsx` as SIBLINGS and no layout beside
 * it: see `connected-accounts/`. These two tests pin that, by rendering the
 * real route tree at both URLs and asking what is on the page.
 */
beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const ARTIFACT = {
  id: "abc",
  name: "eventum-security-audit.md",
  mimeType: "text/plain",
  size: 42,
  content: "# Findings\n\nHIGH the API reflects any Origin.",
};

function serveArtifactApi() {
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    if (url.includes("/api/remi/artifacts/"))
      return json({ artifact: ARTIFACT });
    if (url.includes("/api/remi/artifacts")) {
      return json({ artifacts: [ARTIFACT] });
    }
    // The signed-in person, which the authed layout reads before it renders.
    if (url.includes("/api/me")) {
      return json({
        user: {
          id: "u1",
          email: "owner@example.com",
          role: "user",
          onboarding: null,
        },
      });
    }
    return json({});
  }) as typeof fetch;
}

async function openAt(path: "/settings/files" | "/settings/files/$id") {
  serveArtifactApi();
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  // Built exactly as `app/src/router.tsx` and `main.tsx` build it, including the
  // context the route loaders read `queryClient` from.
  const router = createRouter({
    routeTree,
    context: { queryClient } as never,
    defaultPreload: false,
  });
  // Navigated to WITHOUT the trailing slash on purpose: the sidebar links to
  // "/settings/files", so that is the form that has to resolve to the index.
  await router.navigate({
    to: path,
    ...(path === "/settings/files/$id" ? { params: { id: "abc" } } : {}),
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} context={{ queryClient } as never} />
    </QueryClientProvider>,
  );
  // One settle for the loaders, one for the query behind them.
  await waitFor(() => {
    expect(view.container.textContent).not.toContain("Something went wrong");
  });
  return view;
}

test("the list is the list", async () => {
  const view = await openAt("/settings/files");

  expect(view.container.textContent).toContain("eventum-security-audit.md");
  // The list, so no file's text is on the page yet.
  expect(view.container.textContent).not.toContain("HIGH the API reflects");
  expect(view.container.querySelector("pre")).toBeNull();
});

test("a saved file opens and shows what is inside it", async () => {
  const view = await openAt("/settings/files/$id");

  const contents = view.container.querySelector("pre");
  expect(contents?.textContent).toContain("HIGH the API reflects any Origin.");

  // And the two ways to take it away, both enabled because there is text.
  const actions = [...view.container.querySelectorAll("button")].map(
    (button) => [button.textContent, (button as HTMLButtonElement).disabled],
  );
  expect(actions).toContainEqual(["Copy", false]);
  expect(actions).toContainEqual(["Download", false]);
});
