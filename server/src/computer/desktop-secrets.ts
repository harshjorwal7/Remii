/**
 * A person being asked for one value a Bot must not be told.
 *
 * The shape of this is dictated by what it is FOR. The value a person types — a password, a
 * one-time code, a card number — must never reach the model and must never be written anywhere we
 * could later read it back out. So the server holds no secret at all: it records only that a request
 * is OUTSTANDING, and the moment the person's browser POSTs the value it is typed straight into the
 * focused field and forgotten.
 *
 * THAT MEANS THE VALUE NEVER EXISTED ON THIS SERVER. Not "is not logged", not "is not in the model" —
 * the only copy is the one in the person's form field, and the one this process passes to xdotool.
 *
 * The alternative was the old gateway's `requestSecret`, which needed a provider this deployment does
 * not have and had the same rules; this is the same feature against a machine that actually exists.
 *
 * In memory, per person, with a deadline. The requests are minutes-long hand-offs between a person and
 * a running turn, so a store that outlived them would be a way to ask somebody for a password long
 * after they stopped expecting it. A restart clearing them is the safe direction: the worst outcome is
 * a turn that finds its request gone and says so, rather than one that waits forever for a box that
 * will never appear.
 */

/** How long a request stays outstanding before it is treated as abandoned. */
export const SECRET_REQUEST_TTL_MS = 5 * 60_000;

/**
 * What a completed request hands back: the typed text, or `null` for cancelled/expired.
 *
 * The value passes through THIS PROMISE and nowhere else. It is not in `outstanding`, not in a log,
 * not in a database row and not in the model — it exists in the person's form field, in the POST body,
 * and in the resolve value below, and after the keystrokes that value goes out of scope.
 */
type Answered = string | null;

type Outstanding = {
  /** What the Bot says it needs, for the prompt above the box. Never the value. */
  label: string;
  requestedAt: number;
  answered: Promise<Answered>;
  resolve: (value: Answered) => void;
};

/**
 * Keyed by person rather than by Bot, because the computer is the person's and only one Bot holds it.
 * Two Bots asking at once is the same as one asking: there is one mouse, one focused field, and one
 * masked box.
 */
const outstanding = new Map<string, Outstanding>();

/**
 * Forget anything past its deadline. Called on every read, so an abandoned request cannot linger.
 *
 * `now` is injectable so a test can reach the deadline without waiting five minutes for it. Everything
 * else about this is deliberately un-configurable: a caller-supplied TTL would be a way to leave a
 * masked prompt asking for a password on somebody's screen indefinitely.
 */
export function sweepSecretRequests(now = Date.now()): void {
  for (const [userId, request] of outstanding) {
    if (now - request.requestedAt > SECRET_REQUEST_TTL_MS) {
      outstanding.delete(userId);
      // Released with nothing, rather than left hanging, so a Bot waiting on this is told the request
      // is gone rather than waiting out the full timeout inside a turn that has already lost its
      // place.
      request.resolve(null);
    }
  }
}

/** What the person is being asked for, if anything. `undefined` means no prompt should be shown. */
export function secretWantedFor(userId: string): string | undefined {
  sweepSecretRequests();
  return outstanding.get(userId)?.label;
}

/** Whether a request is outstanding, without the label. Used by the server to keep waiting. */
export function isSecretOutstanding(userId: string): boolean {
  sweepSecretRequests();
  return outstanding.has(userId);
}

/**
 * Note that a request is outstanding, and hand back something to await when it is answered.
 *
 * A second request for the same person REPLACES the first rather than queueing behind it, and the
 * replaced one is released: there is one focused field, so answering the newer question into the older
 * one is not a thing anybody wants, and a Bot waiting on a superseded request should be told so rather
 * than left holding a promise nobody will keep.
 */
export function requestSecret(
  userId: string,
  label: string,
): { answered: Promise<Answered>; superseded: boolean } {
  sweepSecretRequests();
  const previous = outstanding.get(userId);
  if (previous) {
    outstanding.delete(userId);
    previous.resolve(null);
  }

  let resolve!: (value: Answered) => void;
  const answered = new Promise<Answered>((r) => {
    resolve = r;
  });
  outstanding.set(userId, {
    label,
    requestedAt: Date.now(),
    answered,
    resolve,
  });
  return { answered, superseded: Boolean(previous) };
}

/**
 * A person supplied the value: release the waiter and forget it immediately.
 *
 * The caller types it into the desktop. Nothing here sees it, which is the entire design — see the
 * module comment — so this function cannot leak it even by accident, because it never receives it.
 */
export function supplySecret(userId: string, text: string): boolean {
  sweepSecretRequests();
  const request = outstanding.get(userId);
  if (!request) return false;
  // REMOVED BEFORE IT IS RESOLVED. The entry leaves the map before the value is handed anywhere, so
  // there is no window in which the store holds a label AND a way to read a value back out of it.
  outstanding.delete(userId);
  request.resolve(text);
  return true;
}

/** Withdraw a request without an answer, for a person closing the box. */
export function cancelSecret(userId: string): boolean {
  sweepSecretRequests();
  const request = outstanding.get(userId);
  if (!request) return false;
  outstanding.delete(userId);
  request.resolve(null);
  return true;
}

/**
 * Exposed for tests, which must not inherit another test's pending request.
 *
 * Note it does NOT resolve the waiters, and that is correct for its purpose (a test needs a clean
 * slate) but wrong for production — which is why nothing outside a test calls it.
 */
export function resetSecretRequests(): void {
  outstanding.clear();
}
