import { beforeAll, describe, expect, test } from "bun:test";

/**
 * One journey through a running deployment, over HTTP.
 *
 * Every other test in this repository proves a decision in isolation. This one proves the parts are
 * wired to each other: the server reaches the supervisor, the supervisor builds the Bot a computer,
 * the gateway decides before the browser acts, the browser acts, and the trail records it. Nearly
 * every defect worth catching late lives in those joins rather than inside any one of them.
 *
 * Not part of `bun run test`. It needs a deployment that is actually up, with a licence, a model key
 * and Docker, so it is asked for by name:
 *
 *   bash scripts/start.sh
 *   bun run test:smoke
 *
 * `REMII_API_URL` points it at a deployment on other ports. Without `REMII_SMOKE` the file is
 * skipped, so `bun run test` stays honest on a machine with nothing running.
 *
 * IT ALSO NEEDS A SESSION, AND SAYS SO RATHER THAN FINDING OUT THREE TIMES.
 *
 * Everything this journey exists to prove is behind `requireUser`: minting a thread id, reaching the
 * desktop this person owns, taking and handing back the wheel. This file sent no credentials, so on
 * any deployment with an identity provider configured -- which is every deployment this repository
 * will start -- most of its tests answered `401 Authentication required`, and had since the guard
 * was added. A release checklist that asks whether the journey passed was therefore asking for a
 * result nobody could produce.
 *
 * So `REMII_SMOKE_COOKIE` carries a signed-in session, sent verbatim as the `cookie` header. It is
 * a cookie rather than a token because that is what this deployment issues: sign-in is Neon Auth,
 * reached through this server's proxy, and the session is an HTTP-only cookie whose value nothing but
 * the provider can read. Take it from a browser already signed in to the deployment under test:
 * DevTools, Application, Cookies, the `__Host-neon_auth_session` entry, sent as
 * `__Host-neon_auth_session=<value>`.
 *
 * That name is this deployment's own, not the provider's. The provider mints
 * `__Secure-neon-auth.session_token` and it is scoped to the provider's host; `auth/neon.ts` renames it
 * on the way back so the browser holds a cookie belonging to this origin, which is the whole reason
 * the proxy exists. So the cookie to copy is the renamed one, and a run that sends the provider's own
 * name will be refused as signed out.
 *
 * It is a credential with that person's reach, so treat it as one: it belongs in the environment of
 * the run and not in a file, a log or a comment on a pull request.
 *
 *   REMII_SMOKE_COOKIE='__Host-neon_auth_session=...' bun run test:smoke
 *
 * Without it the run stops before the first test with a sentence naming it, rather than skipping the
 * half that matters and reporting the other half as a pass. A journey that did not act on a computer
 * has not been run.
 */

const asked = process.env.REMII_SMOKE === "1";
const API = process.env.REMII_API_URL ?? "http://localhost:3001";
const COOKIE = process.env.REMII_SMOKE_COOKIE ?? "";

/** Long enough for a computer to be created and Chromium to answer on a cold deployment. */
const COMPUTER_TIMEOUT_MS = 180_000;

async function api(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${API}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(COOKIE ? { cookie: COOKIE } : {}),
      ...(init?.headers ?? {}),
    },
  });
}

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await api(path, init);
  if (!response.ok) {
    throw new Error(
      `${init?.method ?? "GET"} ${path} answered ${response.status}: ${(await response.text()).slice(0, 200)}`,
    );
  }
  return (await response.json()) as T;
}

beforeAll(async () => {
  if (!asked) return;
  const reachable = await api("/api/capabilities")
    .then((response) => response.ok)
    .catch(() => false);
  if (!reachable) {
    throw new Error(
      `No deployment is answering at ${API}. Start one with \`bash scripts/start.sh\`, or set REMII_API_URL.`,
    );
  }

  if (!COOKIE) {
    throw new Error(
      "This journey acts as a person, and every route it proves is behind a session. Set " +
        "REMII_SMOKE_COOKIE to the `__Host-neon_auth_session=...` cookie of a browser signed in " +
        `to ${API}. See the comment at the top of this file.`,
    );
  }

  // Asked once, here, so a session that is missing, expired or from another deployment is one
  // sentence at the start rather than the same 401 read three different ways further down.
  //
  // `/api/me`, not `/api/computers/policy`. The policy route used to be the cheapest proof that a
  // session was honoured, but it lives on the per-Bot computer router, and that router is no longer
  // mounted — so probing it answered 404 whatever the cookie was, and a 401 check that can only see
  // 404 cannot tell a bad session from a good one. `/api/me` is behind `requireUser` and mounted
  // unconditionally, so the guard still means what it says.
  const accepted = await api("/api/me");
  if (accepted.status === 401) {
    throw new Error(
      `The session in REMII_SMOKE_COOKIE is not accepted by ${API}. It may have expired, or belong ` +
        "to a different deployment. Sign in again and take a fresh one.",
    );
  }
});

describe.skipIf(!asked)("a deployment that is up", () => {
  test("reports the runtime it is actually running", async () => {
    const capabilities = await json<{ mode: string; durableHistory: boolean }>(
      "/api/capabilities",
    );
    expect(capabilities.mode).toBe("local");
    expect(capabilities.durableHistory).toBe(true);
  });

  test("serves runtime info with Bots registered and no licence gate", async () => {
    // The local runtime issues no licence: health is "it answers and names
    // its Bots". A product that silently degraded would be worth failing a
    // smoke test over; this asserts the opposite directly.
    const info = await json<{
      mode?: string;
      agents: Record<string, unknown>;
    }>("/api/copilotkit/info");
    expect(Object.keys(info.agents).length).toBeGreaterThan(0);
  });

  test("mints thread ids that say which deployment they came from", async () => {
    const { threadId } = await json<{ threadId: string }>("/api/threads/mint", {
      method: "POST",
    });
    expect(threadId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });
});

/*
 * THE DESKTOP, WHICH IS ONE MACHINE HELD BY Remii AND HAS NO REST NAVIGATION.
 *
 * This leg used to drive a per-Bot computer through `/api/computers/<bot>/navigate` and to read and
 * write `/api/computers/policy`. Both of those addresses are gone: `computerProvider` is
 * `undefined` in this deployment, so the per-Bot router is never mounted and every route on it
 * answers 404. The journey was therefore asserting two things that could not be true of any
 * deployment built from this tree — it would have failed at the first call, and the failure would
 * have read as a broken product rather than as a test left behind by a shape the product left behind.
 *
 * What replaced them is smaller on purpose, and the difference matters. There is one desktop per
 * person at `/api/computers/desktop`, it is watched over a socket, and ACTING on it — navigating,
 * clicking, and the boundary that decides before a click lands — is reached through the agent tool
 * path, not through a URL a person can POST to. So this leg proves what only HTTP can prove: that the
 * desktop is reachable, that it answers a real captured frame rather than a placeholder, and that the
 * wheel can be taken and handed back. Navigation and policy enforcement are real and are covered, but
 * not from here, and this file says so rather than implying a coverage it does not have.
 */
describe.skipIf(!asked)("the desktop this person owns", () => {
  test(
    "reports itself, and answers a real frame of Remii's screen",
    async () => {
      const state = await json<{
        computer: {
          status: string;
          displayWidth: number | null;
          displayHeight: number | null;
        } | null;
        hoursUsed?: number;
        hoursIncluded?: number;
        isolation?: string;
      }>("/api/computers/desktop/state");

      /*
       * EITHER SHAPE IS CORRECT AND NEITHER IS AN ERROR.
       *
       * `computer: null` with `reason: "no-computer-yet"` is the ordinary state of somebody who has
       * never asked Remii for a screen: the desktop wakes on demand and costs nothing while it is
       * off, so a person who has not used it has no row at all. Asserting a row exists would be
       * asserting that this journey had already spent money before it began.
       */
      if (state.computer) {
        // Hours come from the plan, not a fixed number: this is the meter's own answer.
        expect(state.hoursIncluded).toBeGreaterThan(0);
        expect(state.isolation).toBe("per-person");
      }

      const shot = await api("/api/computers/desktop/screenshot");

      if (state.computer === null) {
        /*
         * Nothing was provisioned, so there is nothing to photograph. 503 with a sentence naming the
         * machine is the honest answer — and the reason this is checked rather than waited on is
         * that the screen is started BY USE: making this test wake a E2B box would make reading
         * a page cost money.
         */
        expect(shot.status).toBe(503);
        expect((await shot.json()).error).toBeTruthy();
        return;
      }

      expect(shot.ok).toBe(true);
      const frame = (
        (await shot.json()) as {
          frame: { base64: string; width: number; height: number };
        }
      ).frame;
      // A real capture, not an empty string and not a placeholder: base64 of nothing decodes to
      // nothing, and a zero width is what a failed capture reports.
      expect(frame.base64.length).toBeGreaterThan(0);
      expect(frame.width).toBeGreaterThan(0);
      expect(frame.height).toBeGreaterThan(0);
    },
    COMPUTER_TIMEOUT_MS,
  );

  test(
    "hands the wheel over and takes it back",
    async () => {
      const before = await json<{ holder: string | null }>(
        "/api/computers/desktop/control",
      );

      await json("/api/computers/desktop/control/take", { method: "POST" });
      const held = await json<{ holder: string }>(
        "/api/computers/desktop/control",
      );
      expect(held.holder).toBe("human");

      await json("/api/computers/desktop/control/release", { method: "POST" });

      /*
       * What the desktop holds afterwards is not asserted to be empty: somebody may be driving it,
       * Remii may have taken it back, and forcing it to a particular answer here would make this
       * journey depend on there being no one else at the keyboard. What it must never be is a
       * takeover this run failed to give back.
       */
      const after = await json<{ holder: string | null }>(
        "/api/computers/desktop/control",
      );
      if (before.holder === null) {
        expect(after.holder === null || after.holder === "bot").toBe(true);
      }
    },
    COMPUTER_TIMEOUT_MS,
  );
});
