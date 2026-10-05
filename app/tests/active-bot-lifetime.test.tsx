import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, cleanup, render } from "@testing-library/react";
import {
  ActiveBotProvider,
  useActiveBot,
  useActiveBotHolder,
} from "../src/lib/copilot/active-bot";

/**
 * Which Bot a computer tool call is addressed to, at the moment it runs.
 *
 * The handlers read a ref rather than state, because a handler outlives the
 * render that registered it — and that is the whole bug. A computer tool call is
 * executed by the browser AFTER the run that asked for it has finished, so a
 * turn in flight outlives the page that started it. Leaving a chat for another
 * page in the app unmounts the surface mid-run, and if the holder falls back to
 * the placeholder the call is addressed to a Bot that does not exist: it comes
 * back "your computer could not be reached", the chain stops where it stood, and
 * the only way on is to type "continue".
 *
 * The probe below stands in for a tool handler: it is mounted with the surface
 * and read after that surface is gone, which is the shape of the failure.
 */
beforeAll(() => GlobalRegistrator.register());
afterAll(() => GlobalRegistrator.unregister());

/*
 * Unmount what this file rendered, before it unregisters the DOM.
 *
 * This file was the only one rendering without a cleanup, and that was enough to fail five tests in
 * OTHER files. Testing-library's `cleanup()` is global: it removes every container any render in this
 * process created. So a container left behind here outlived its test, and by the time a later file
 * ran its own cleanup that container's parent was a document this file had already torn down —
 * "Failed to execute 'removeChild' on 'Node': The node to be removed is not a child of this node",
 * attributed to whichever test happened to run next.
 *
 * The failure pointed at component rendering, at the preview renderer, and at the detail panel. It
 * was none of them: it was this file leaving a room light on.
 */
afterEach(cleanup);

/**
 * Captures the HOLDER, not its value, which is the point: a handler reads
 * `.current` at the moment it runs, so a test that copied the string during
 * render would be asserting about the render rather than about the call.
 */
const held: { holder: { current: string } | null } = { holder: null };
const read = () => held.holder?.current ?? "unread";

/**
 * Effects have run, before anything is read.
 *
 * `useActiveBot` declares the Bot from inside `useEffect`, and `render` normally flushes passive
 * effects before it returns. It is not guaranteed to: React 19 hands that work to its scheduler, and
 * under some environments (CI among them) the callback has not run by the time `render` returns, so
 * the holder still reads `"default"` and this file failed with
 * `Expected: "bot-1" / Received: "default"` — on a machine where the code is correct. Draining the
 * scheduler inside `act` makes the order the test means to assert the order it gets.
 */
async function settled() {
  await act(async () => {
    await Promise.resolve();
  });
}

function Probe() {
  held.holder = useActiveBotHolder();
  return null;
}

function Surface({ botId }: { botId: string | undefined }) {
  useActiveBot(botId);
  return null;
}

describe("a Bot declared by a surface that has gone away", () => {
  test("is still what a pending tool call is addressed to", async () => {
    const view = render(
      <ActiveBotProvider>
        <Surface botId="bot-1" />
        <Probe />
      </ActiveBotProvider>,
    );
    await settled();
    expect(read()).toBe("bot-1");

    // The person walks to another page in the app. The run is still going.
    view.unmount();
    await settled();

    // Not the placeholder. That value has no agent behind it, so a call sent
    // there cannot be carried out and the turn dies where it stood.
    expect(read()).toBe("bot-1");
  });

  test("a second surface still takes the value for itself", async () => {
    // The restore exists so one channel cannot leave its Bot addressed to
    // whatever mounts next, and that has to keep working.
    const first = render(
      <ActiveBotProvider>
        <Surface botId="bot-1" />
        <Probe />
      </ActiveBotProvider>,
    );
    await settled();
    expect(read()).toBe("bot-1");
    first.unmount();
    await settled();

    render(
      <ActiveBotProvider>
        <Surface botId="bot-2" />
        <Probe />
      </ActiveBotProvider>,
    );
    await settled();
    expect(read()).toBe("bot-2");
  });

  test("a surface that declares nothing takes the placeholder", async () => {
    // Before anything has declared a Bot there is nothing to stand on, and the
    // placeholder is the honest answer: the tool refuses it with its own
    // sentence rather than addressing a Bot that does not exist.
    render(
      <ActiveBotProvider>
        <Surface botId={undefined} />
        <Probe />
      </ActiveBotProvider>,
    );
    await settled();
    expect(read()).toBe("default");
  });
});
