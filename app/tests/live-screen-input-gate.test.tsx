import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, cleanup, render, waitFor } from "@testing-library/react";

/**
 * YOU CANNOT STEER THE BOT'S SCREEN BY CLICKING IT.
 *
 * The reported behaviour was that clicks land on the live desktop while the Bot is driving it, without
 * "Take control" ever having been pressed. That is worse than it looks, because it is invisible from the
 * browser:
 *
 * The Bot's own tools ARE refused server-side while a person holds control (`controlHolder`), so its next
 * action fails with "a person has control" and the run carries on as though nothing had interfered. The
 * person watches their click take effect on a real desktop. Nothing reports a collision, because the only
 * party who could notice is the one being moved out of the way — so a click can dismiss the dialog the Bot
 * was about to read, or retype into the field it had just filled, and the failure surfaces much later as
 * a confidently wrong answer.
 *
 * The live screen therefore covers itself while the Bot holds the wheel, and offers Take control on the
 * same surface. These tests hold that in place, and hold the equally important other half: when the person
 * DOES have the wheel there is no overlay at all, so the input path is absent rather than gated.
 */

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

let holder: "bot" | "human" = "bot";
let _streamCalls = 0;
/** How many times the overlay's own Take control was pressed. */
let _takeCalls = 0;

function answerEndpoints(input: unknown) {
  const path = String(input);
  if (path.includes("/desktop/stream")) {
    _streamCalls += 1;
    return json({
      url: "https://6080-sbx-abc.e2b.app/vnc.html",
      authKey: "pw",
      width: 1920,
      height: 1080,
    });
  }
  if (path.endsWith("/control/take")) {
    _takeCalls += 1;
    holder = "human";
    return json({ holder: "human", since: "", requested: false });
  }
  if (path.endsWith("/control/release")) {
    holder = "bot";
    return json({ holder: "bot", since: "", requested: false });
  }
  return json({ holder, requested: false });
}

let restore: () => void = () => {};
beforeAll(() => {
  GlobalRegistrator.register();
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => "visible",
  });
  document.dispatchEvent(new Event("visibilitychange"));

  const f = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) =>
    answerEndpoints(input)) as never;
  restore = () => {
    globalThis.fetch = f;
  };
});

afterEach(() => {
  cleanup();
  holder = "bot";
  _streamCalls = 0;
  _takeCalls = 0;
});

afterAll(() => {
  restore();
  cleanup();
  GlobalRegistrator.unregister();
});

async function mount(props: { driving: boolean; withTakeControl?: boolean }) {
  const { LiveScreen } = await import("@/components/computer/live-screen");
  const onControl = (() => {}) as (state: {
    holder: "bot" | "human";
    since: string;
    requested: boolean;
  }) => void;
  const view = render(
    <LiveScreen
      computerId="bot-1"
      driving={props.driving}
      session={{ url: "https://6080-sbx-abc.e2b.app/vnc.html", authKey: "pw" }}
      {...(props.withTakeControl === false
        ? {}
        : {
            takeControl: () =>
              fetch("/api/computers/desktop/control/take").then(() => null),
            onControl,
          })}
    />,
  );
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
  return view;
}

const overlay = (container: HTMLElement) =>
  [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === "Take control",
  );

describe("the live desktop while the Bot is driving it", () => {
  test("shows the live stream directly without text overlay or blocking button", async () => {
    const { container } = await mount({ driving: false });

    await waitFor(() =>
      expect(container.querySelector("iframe")).not.toBeNull(),
    );

    const iframe = container.querySelector("iframe");
    expect(iframe?.className).toContain("pointer-events-none");
    expect(overlay(container)).toBeUndefined();
    expect(container.textContent).not.toContain(
      "The assistant is using the computer.",
    );
  });

  test("enables pointer events directly when the person holds the wheel", async () => {
    const { container } = await mount({ driving: true });

    await waitFor(() =>
      expect(container.querySelector("iframe")).not.toBeNull(),
    );

    const iframe = container.querySelector("iframe");
    expect(iframe?.className).toContain("pointer-events-auto");
    expect(overlay(container)).toBeUndefined();
    expect(container.textContent).not.toContain(
      "The assistant is using the computer.",
    );
  });
});
