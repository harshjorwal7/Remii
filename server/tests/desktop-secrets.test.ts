import { beforeEach, describe, expect, test } from "bun:test";
import {
  cancelSecret,
  isSecretOutstanding,
  SECRET_REQUEST_TTL_MS,
  requestSecret,
  resetSecretRequests,
  secretWantedFor,
  supplySecret,
  sweepSecretRequests,
} from "../src/computer/desktop-secrets";

/**
 * A value a person typed, and the only promises this module makes about it.
 *
 * The property under test is not "does the flow work" — it is that THE VALUE IS NOT HELD. Every other
 * implementation of this feature that has ever existed has been a place a password could be read back
 * out of: a database row, a log line, a session store, a model message. This one cannot be, because
 * there is nowhere in this file that a value is written — it is handed from the route that receives it
 * to the promise that a keystroke is typed from, and that is the whole of its life.
 *
 * So the tests below are mostly about ABSENCE, which is unusual and deliberate: an assertion that a
 * value is not retrievable is the assertion that matters here, and a happy-path test alone would pass
 * just as happily against an implementation that stored every password it was ever given.
 */

const USER = "user_secret_test";

beforeEach(() => {
  resetSecretRequests();
});

describe("what a person is being asked for", () => {
  test("is the LABEL, and only when something is outstanding", () => {
    expect(secretWantedFor(USER)).toBeUndefined();

    requestSecret(USER, "the code sent to your phone");
    expect(secretWantedFor(USER)).toBe("the code sent to your phone");
    expect(isSecretOutstanding(USER)).toBe(true);
  });

  test("is absent rather than null when nothing is asked for", () => {
    // The browser tests PRESENCE, so an explicit null would read as a request for a blank value and
    // put a masked box on somebody's screen with nothing to fill in.
    expect(secretWantedFor(USER)).toBeUndefined();
    expect(secretWantedFor(USER)).not.toBeNull();
  });

  test("is per person, so two people never see each other's prompt", () => {
    requestSecret(USER, "a password");
    expect(secretWantedFor("someone_else")).toBeUndefined();
  });
});

describe("the value itself", () => {
  test("reaches the waiter exactly once and is not retrievable afterwards", async () => {
    const { answered } = requestSecret(USER, "a one-time code");
    expect(supplySecret(USER, "123456")).toBe(true);

    // The waiter gets it. That is the one place it is allowed to exist.
    expect(await answered).toBe("123456");

    // And nowhere else. A second read finds nothing at all — not the value, not a pending request,
    // not a hint that one ever existed.
    expect(secretWantedFor(USER)).toBeUndefined();
    expect(isSecretOutstanding(USER)).toBe(false);
  });

  test("is refused when nobody is waiting, rather than accepted into a void", () => {
    // A person who types a password into a box whose Bot has given up must be TOLD, not left believing
    // it went somewhere. Silently accepting it is how a credential ends up typed into the wrong field.
    expect(supplySecret(USER, "hunter2")).toBe(false);
  });

  test("is not held after a cancellation either", async () => {
    const { answered } = requestSecret(USER, "a password");
    expect(cancelSecret(USER)).toBe(true);

    expect(await answered).toBeNull();
    expect(secretWantedFor(USER)).toBeUndefined();
  });

  test("a second request supersedes the first and releases it rather than deadlocking", async () => {
    /*
     * One focused field, so answering the older question into the newer one is not a thing anybody
     * wants. A Bot holding the superseded promise must be let go — otherwise its turn waits out the
     * full timeout for a box that no longer exists.
     */
    const first = requestSecret(USER, "the first thing");
    const second = requestSecret(USER, "the second thing");

    expect(first.superseded).toBe(false);
    expect(second.superseded).toBe(true);
    expect(await first.answered).toBeNull();
    expect(secretWantedFor(USER)).toBe("the second thing");
  });
});

describe("expiry", () => {
  /**
   * Driven through the sweep with an injected clock rather than by waiting five real minutes, which is
   * the only reason that seam exists and the only reason it takes an argument.
   */
  test("a request nobody answered is forgotten rather than lingering", async () => {
    const { answered } = requestSecret(USER, "a password");
    expect(isSecretOutstanding(USER)).toBe(true);

    // One millisecond short of the deadline: still outstanding.
    sweepSecretRequests(Date.now() + SECRET_REQUEST_TTL_MS - 1);
    expect(isSecretOutstanding(USER)).toBe(true);

    // Past it: gone. A prompt that stayed on somebody's screen asking for a password long after the
    // turn that wanted it gave up is worse than no prompt at all.
    sweepSecretRequests(Date.now() + SECRET_REQUEST_TTL_MS + 1);
    expect(isSecretOutstanding(USER)).toBe(false);
    expect(secretWantedFor(USER)).toBeUndefined();
    // And the waiter is RELEASED with nothing, rather than left holding a promise nobody will keep —
    // which would hang the turn until the loop's own tool timeout killed it.
    expect(await answered).toBeNull();
  });

  test("a value supplied after expiry is refused, not silently accepted", () => {
    requestSecret(USER, "a password");
    sweepSecretRequests(Date.now() + SECRET_REQUEST_TTL_MS + 1);

    // Somebody types their password into a box whose Bot has given up. They must be told, not left
    // believing it went somewhere.
    expect(supplySecret(USER, "late")).toBe(false);
  });

  test("an in-flight request survives an unrelated sweep", () => {
    // The sweep is on the read path, so it runs constantly. It must not disturb a request that is
    // still inside its window, which is the case that actually happens during a normal login.
    const { answered } = requestSecret(USER, "a password");
    sweepSecretRequests();
    expect(isSecretOutstanding(USER)).toBe(true);
    expect(supplySecret(USER, "ok")).toBe(true);
    expect(answered).toBeDefined();
  });
});
