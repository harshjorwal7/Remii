import { expect, test } from "bun:test";
import { router } from "../src/router";
import {
  routeBuildRollupOutputOptions,
  routeCodeSplittingOptions,
  selectedRouteSplitBehavior,
  selectRemiiManualChunk,
} from "../vite.config";

test("provides the generated index route", () => {
  expect(router.routesByPath["/"]?.fullPath).toBe("/");
});

test("provides the generated sign-in and chat routes", () => {
  expect(router.routesByPath["/sign"]?.fullPath).toBe("/sign");
  expect(router.routesByPath["/channel/$channelId"]?.fullPath).toBe(
    "/channel/$channelId",
  );
});

test("provides the generated settings routes", () => {
  const byPath = router.routesByPath as unknown as Record<
    string,
    { fullPath?: string }
  >;
  expect(byPath["/settings/connected-accounts"]?.fullPath).toBe(
    "/settings/connected-accounts/",
  );
});

/*
 * A saved file is only useful if it can be opened.
 *
 * The list and the read endpoint had existed the whole time with nothing joining them: the page said
 * "reading one opens the saved text" and every row was plain text with a Delete beside it, so the
 * content the server was already serving had no way onto the screen. The route is the fix, and this
 * is what stops it being deleted as unused — a route with no test is a route nobody has followed.
 */
test("a saved file has a page of its own to open it on", () => {
  const byPath = router.routesByPath as unknown as Record<
    string,
    { fullPath?: string; id?: string }
  >;
  /*
   * The index registers with a trailing slash because it is an INDEX route and
   * no longer a layout with a child under it. The pair is deliberately
   * SIBLINGS — `files/index.tsx` and `files/$id.tsx`, with no `files.tsx`
   * beside them — which is the shape every other list-and-detail pair in these
   * settings uses (see `connected-accounts/`). As a layout it rendered the list
   * at the detail URL too and the child never mounted.
   */
  expect(byPath["/settings/files/$id"]?.fullPath).toBe("/settings/files/$id");
  // The list is an INDEX now, so it answers to the same key it always did and
  // carries the trailing slash an index route's path has.
  expect(byPath["/settings/files"]?.fullPath).toBe("/settings/files/");
  // And it is a sibling of the detail route, not a layout above it. This is the
  // assertion that failed when the two were a flat file beside a directory: as
  // a layout it rendered the list at the detail URL and the child never mounted.
  expect(byPath["/settings/files/$id"]?.id).toBe("/_authed/settings/files/$id");
  expect(byPath["/settings/files"]?.id).toBe("/_authed/settings/files/");
});

test("splits route components without splitting loaders or providers", () => {
  expect(routeCodeSplittingOptions.defaultBehavior).toEqual([]);
  expect(selectedRouteSplitBehavior({ routeId: "/sign" })).toEqual([
    ["component"],
  ]);
  expect(
    selectedRouteSplitBehavior({ routeId: "/_authed/_app/channel/$channelId" }),
  ).toEqual([["component"]]);
  expect(
    selectedRouteSplitBehavior({
      routeId: "/_authed/settings/connected-accounts/index",
    }),
  ).toEqual([["component"]]);
  expect(
    selectedRouteSplitBehavior({ routeId: "/settings/connected-accounts/" }),
  ).toEqual([["component"]]);
  expect(selectedRouteSplitBehavior({ routeId: "/" })).toBeUndefined();
});

test("uses explicit manual chunks for route components", () => {
  expect(routeBuildRollupOutputOptions.onlyExplicitManualChunks).toBe(true);
  expect(
    selectRemiiManualChunk(
      "/repo/app/src/routes/sign.tsx?tsr-split=component",
    ),
  ).toBe("route-sign");
  expect(
    selectRemiiManualChunk(
      "C:\\repo\\app\\src\\routes\\_authed\\_app\\channel\\$channelId.tsx?tsr-split=component",
    ),
  ).toBe("route-chat-core");
  expect(
    selectRemiiManualChunk(
      "/repo/app/src/routes/_authed/settings/connected-accounts/$key.tsx?tsr-split=component",
    ),
  ).toBe("route-settings");
  expect(
    selectRemiiManualChunk(
      "/repo/app/src/routes/_authed/settings/connected-accounts/index.tsx?tsr-split=component",
    ),
  ).toBe("route-settings");
  expect(
    selectRemiiManualChunk(
      "/repo/app/src/routes/_authed/_app/agents/index.tsx?tsr-split=component",
    ),
  ).toBe("route-app-secondary");
});

test("does not manually chunk lazy content or dependencies", () => {
  expect(
    selectRemiiManualChunk(
      "/repo/app/src/routes/_authed/_app/channel/$channelId.tsx?tsr-split=loader",
    ),
  ).toBeUndefined();
  expect(
    selectRemiiManualChunk(
      "/repo/app/src/components/markdown/lazy-mermaid.tsx",
    ),
  ).toBeUndefined();
  expect(
    selectRemiiManualChunk(
      "/repo/node_modules/.bun/mermaid@11.12.1/node_modules/mermaid/dist/mermaid.core.mjs",
    ),
  ).toBeUndefined();
  expect(
    selectRemiiManualChunk(
      "/repo/node_modules/.bun/@copilotkit+react-core@1.70.1/node_modules/@copilotkit/react-core/dist/index.js",
    ),
  ).toBeUndefined();
  expect(
    selectRemiiManualChunk(
      "/repo/node_modules/.bun/react-dom@19.2.0/node_modules/react-dom/client.js",
    ),
  ).toBeUndefined();
});
