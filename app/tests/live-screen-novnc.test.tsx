import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render, waitFor } from "@testing-library/react";

/**
 * The live screen is noVNC, and these are the things that get a person's desktop wrong.
 *
 * The component this replaced was a canvas that drew base64 JPEG frames and forwarded mouse and key
 * events over a websocket. Every test in the old `live-screen-mouse.test.tsx` was about that path —
 * click-versus-drag, wheel direction, paste forwarding, `Ctrl+A` staying remote while `Cmd+V` stays
 * local. Those were hard problems, they were solved correctly, and they are now solved by noVNC over
 * RFB instead of by hand. So that file is gone rather than broken.
 *
 * The tests move to the boundary that is actually ours, which is handing the browser a URL and a
 * password and then getting out of the way. Three things go wrong there and each is a real exposure:
 *
 *  1. THE PASSWORD LEAKS. It travels in a query string, so it lands in browser history and in the
 *     `Referer` of anything the frame loads. `referrerPolicy="no-referrer"` is load-bearing, not tidy.
 *  2. THE FRAME IS OVER-PRIVILEGED. noVNC needs `allow-scripts` and, for the clipboard a person
 *     expects to work, `allow-same-origin`. Nothing else — a sandbox host is not trusted code.
 *  3. THE SCREEN OPENS THE WRONG WAY. noVNC defaults host and port to `window.location`'s, which sends
 *     RFB traffic back through this deployment's own origin, where there is no route, so it never
 *     connects. And a closed socket looks exactly like a wrong password in noVNC's status panel.
 */

/** What the server hands back, and what it says when it cannot. */
const SESSION = {
  url: "https://6080-sbx-abc.e2b.app/vnc.html?autoconnect=true",
  authKey: "s3cr3t-vnc-key",
  width: 1920,
  height: 1080,
};

const requested: string[] = [];
let answer: { ok: boolean; body: unknown } = { ok: true, body: SESSION };

/*
 * `globalThis.fetch`, NOT `mock.module("@/lib/client")`.
 *
 * `mock.module` is process-wide in bun, so replacing a module here replaces it for every other test
 * file in the same run — it made `computer-problem-card.test.tsx` fail against this file's endpoints.
 * Stubbing fetch is local, and it is what the other test in this area already does for the same reason.
 */
const { LiveScreen } = await import("@/components/computer/live-screen");
const { openDesktopStream, vncUrlFor } = await import("@/lib/computers/screen");

let originalFetch: typeof globalThis.fetch;

beforeAll(() => {
  GlobalRegistrator.register();
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    requested.push(String(input));
    return new Response(JSON.stringify(answer.body), {
      status: answer.ok ? 200 : 503,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
});

afterEach(() => {
  cleanup();
  requested.length = 0;
  answer = { ok: true, body: SESSION };
});

afterAll(() => {
  globalThis.fetch = originalFetch;
  GlobalRegistrator.unregister();
});

/** Render, and wait for the session to arrive. */
async function mount(
  props: Partial<{
    driving: boolean;
    onProblem: (p: string | null) => void;
  }> = {},
) {
  const view = render(
    <LiveScreen
      computerId="bot-1"
      driving={props.driving ?? true}
      onProblem={props.onProblem ?? (() => {})}
    />,
  );
  await waitFor(() =>
    expect(
      view.container.querySelector("iframe") ?? view.container.textContent,
    ).toBeTruthy(),
  );
  return view;
}

describe("the URL handed to noVNC", () => {
  const url = () =>
    new URL(vncUrlFor({ url: SESSION.url, authKey: SESSION.authKey }));

  test("carries the password and autoconnects", () => {
    expect(url().searchParams.get("password")).toBe("s3cr3t-vnc-key");
    expect(url().searchParams.get("autoconnect")).toBe("true");
  });

  test("scales the desktop to the panel rather than showing it at native size", () => {
    // 1920 wide inside a 900px column at `resize=off` means the person pans to see anything.
    expect(url().searchParams.get("resize")).toBe("scale");
  });

  test("reconnects on its own, because a laptop waking is not the product breaking", () => {
    expect(url().searchParams.get("reconnect")).toBe("true");
  });

  test("names the host E2B gave us rather than inheriting this deployment's own", () => {
    /*
     * The failure that is invisible.
     *
     * noVNC reads host and port off its own URL and falls back to `window.location` when they are
     * absent. RFB traffic would then go to THIS deployment's origin, where no route exists, so it
     * would never connect — and the visible symptom of that is "authentication failed", because a
     * closed socket and a wrong password look the same in noVNC's status panel.
     */
    expect(url().host).toBe("6080-sbx-abc.e2b.app");
    expect(url().host).not.toContain("localhost");
  });

  test("refuses a URL that is not https, rather than handing a password to it", async () => {
    answer = {
      ok: true,
      body: {
        url: "http://elsewhere.example.com/vnc.html",
        authKey: "k",
        width: 1,
        height: 1,
      },
    };
    await expect(openDesktopStream()).rejects.toThrow(/not running/i);
  });

  test("refuses a session with no password", async () => {
    // An unauthenticated desktop is not a degraded screen. It is somebody else's screen.
    answer = {
      ok: true,
      body: { url: SESSION.url, width: 1920, height: 1080 },
    };
    await expect(openDesktopStream()).rejects.toThrow(/not running/i);
  });

  test("falls back to a usable size when the server sends none", async () => {
    answer = { ok: true, body: { url: SESSION.url, authKey: "k" } };
    const session = await openDesktopStream();
    expect(session.width).toBeGreaterThan(0);
    expect(session.height).toBeGreaterThan(0);
  });
});

describe("the frame it renders", () => {
  test("loads the desktop from E2B and sends no Referer", async () => {
    const view = await mount();
    const frame = view.container.querySelector("iframe");

    expect(requested).toContain("/api/computers/desktop/stream");
    expect(frame?.getAttribute("src")).toContain("6080-sbx-abc.e2b.app");
    // Load-bearing, not tidy: the password is in the query string, and anything the frame loads would
    // otherwise see it.
    expect(frame?.getAttribute("referrerpolicy")).toBe("no-referrer");
  });

  test("grants noVNC only what it needs, because a sandbox host is not trusted code", async () => {
    const view = await mount();
    const sandbox =
      view.container.querySelector("iframe")?.getAttribute("sandbox") ?? "";

    // Required for noVNC to run at all, and for the clipboard a person expects to work.
    expect(sandbox).toContain("allow-scripts");
    expect(sandbox).toContain("allow-same-origin");
    // Not required, and each of these is a way out of the frame.
    expect(sandbox).not.toContain("allow-top-navigation");
    expect(sandbox).not.toContain("allow-popups");
    expect(sandbox).not.toContain("allow-forms");
    expect(sandbox).not.toContain("allow-modals");
  });

  test("is interactive whether or not the wheel is held, because the server decides that", async () => {
    /*
     * The one deliberate non-change, and getting it wrong would be the worst bug in this component.
     *
     * noVNC is interactive from the moment it connects. Gating input on `driving` as well would leave a
     * person who pressed "Take control" clicking at a desktop that ignored them, while a Bot quietly
     * kept driving the same machine — precisely the two-writers-one-mouse outcome the wheel exists to
     * prevent. `controlHolder` on the row is what actually decides, server side.
     */
    const view = await mount({ driving: false });
    expect(
      view.container.querySelector("iframe")?.getAttribute("src"),
    ).toContain("autoconnect=true");
  });

  test("reports upward when the desktop cannot be opened, and shows no frame", async () => {
    answer = { ok: false, body: { error: "This computer is not running." } };
    const seen: (string | null)[] = [];
    const view = await mount({ onProblem: (problem) => seen.push(problem) });

    expect(view.container.querySelector("iframe")).toBeNull();
    // Reported, and NOT drawn here.
    expect(seen).toContain("This computer is not running.");
  });

  test("does not draw the reason itself, because the parent already has a surface for it", async () => {
    /*
     * It used to render the sentence as well as report it, and the parent renders the same sentence in
     * the overlay above this component — so a desktop that could not be opened said why twice. Which is
     * exactly what `computer-problem-card.test.tsx` is for, and it is a reminder that a component which
     * reports an error to its parent does not also get to render it.
     */
    answer = { ok: false, body: { error: "This computer is not running." } };
    const view = await mount();

    expect(view.container.textContent).not.toContain(
      "This computer is not running.",
    );
  });

  test("uses a session the parent warmed, without asking again", async () => {
    /*
     * THE LATENCY FIX, and it is the one that matters to a person rather than to a monitor.
     *
     * Fetching on mount puts a round trip to a remote machine between their click and seeing anything,
     * and on a desktop that has gone to sleep that round trip is a RESUME — several seconds of blank
     * panel on the one gesture that is supposed to feel like taking hold of something.
     */
    const view = render(
      <LiveScreen
        computerId="bot-1"
        driving
        session={{ url: SESSION.url, authKey: SESSION.authKey }}
        onProblem={() => {}}
      />,
    );
    await waitFor(() =>
      expect(view.container.querySelector("iframe")).toBeTruthy(),
    );

    expect(requested).not.toContain("/api/computers/desktop/stream");
    // The password is attached at the last moment, here rather than by whoever warmed the session.
    const frame = view.container.querySelector("iframe");
    expect(frame?.getAttribute("src")).toContain("password=s3cr3t-vnc-key");
  });

  test("falls back to fetching for itself when there is nothing warmed", async () => {
    // Warming is an optimisation, not a requirement. Without it this is slower and identical.
    const view = await mount();
    expect(requested).toContain("/api/computers/desktop/stream");
    expect(view.container.querySelector("iframe")).toBeTruthy();
  });

  test("registers no window-level key handler, so the app's own shortcuts cannot steal a keystroke", async () => {
    /*
     * A REAL bug this file inherits a fix for.
     *
     * Every keystroke while a person was driving belonged to the desktop, and the app's shortcuts
     * listen on the same window. They were bound first, when the signed-in app mounted, so they saw
     * each keystroke before the screen did and acted on it as well. Typing a capital N into a page —
     * "New York" in a search box — started a new chat and took the person away from the desktop
     * mid-word, and Ctrl+B, bold in a document, showed and hid the sidebar here as well.
     *
     * The old canvas forwarded keys itself and had to beat those handlers to the punch. This iframe
     * cannot: keyboard events inside an iframe do not bubble out to the parent document, so there is
     * nothing on the parent window to receive a keystroke typed into the desktop. The fix is structural
     * rather than a race, which is why there is no handler here to assert the behaviour of — the
     * assertion is that there is NOBODY.
     */
    const added: string[] = [];
    const realAdd = document.addEventListener.bind(document);
    const realWindowAdd = window.addEventListener.bind(window);
    document.addEventListener = ((type: string, ...rest: unknown[]) => {
      added.push(`document:${type}`);
      return (realAdd as never as (t: string, ...r: unknown[]) => void)(
        type,
        ...rest,
      );
    }) as never;
    window.addEventListener = ((type: string, ...rest: unknown[]) => {
      added.push(`window:${type}`);
      return (realWindowAdd as never as (t: string, ...r: unknown[]) => void)(
        type,
        ...rest,
      );
    }) as never;

    try {
      await mount();
    } finally {
      document.addEventListener = realAdd as never;
      window.addEventListener = realWindowAdd as never;
    }

    const keyish = added.filter((entry) =>
      /key|keypress|keyup|input/i.test(entry),
    );
    expect(keyish).toEqual([]);
  });

  test("asks for the screen once, however many times the parent re-renders", async () => {
    const view = await mount();
    // A brand-new closure, which is what every parent render produces.
    view.rerender(
      <LiveScreen computerId="bot-1" driving={false} onProblem={() => {}} />,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Depending on `onProblem` would tear down a working screen and re-authenticate it on every
    // unrelated state change above this component — which reads to a person as the screen flickering.
    expect(requested.filter((path) => path.includes("/stream"))).toHaveLength(
      1,
    );
  });
});
