import { tryClient } from "@/lib/client";

/**
 * Handing control of a Bot's computer to a person, and back.
 *
 * Plain functions rather than factories, and every one of them fails closed. Nothing here is cached:
 * who holds the wheel is a fact about this second, and a stale copy of it would be worse than no
 * copy — it would show somebody a screen they cannot drive, or let them think they can.
 *
 * The reads answer `null` on failure rather than throwing. A panel that cannot say who is driving
 * should say nothing, not tear down the screen the person is looking at.
 */

export type ControlState = {
  holder: "bot" | "human";
  since: string;
  reason?: string;
  requested: boolean;
  /** What the Bot is waiting for, by name only. Present means show the masked prompt. */
  secretWanted?: string;
};

/**
 * The wheel belongs to the person, not to a Bot.
 *
 * The computer is one E2B desktop per user, so "which computer is this" was never a question
 * this file could answer by naming a Bot — there is exactly one, and it belongs to whoever is
 * signed in. These calls used to address `/api/computers/<botId>/control`, which is the old
 * per-Bot Chromium surface; under the E2B desktop that route does not exist and answers 404.
 *
 * That 404 was quiet and it was the whole bug: every read failed closed, so the UI believed
 * nobody held the wheel, `driving` stayed false, and the live screen never mounted — a working
 * E2B desktop that could not be shown. The signature keeps `computerId` so the callers and
 * the poll loop are untouched; the address is now the one desktop the person owns.
 */
const DESKTOP_CONTROL = "/api/computers/desktop";

async function callControl(
  _computerId: string,
  path: string,
  method?: string,
): Promise<ControlState | null> {
  const response = await tryClient(
    `${DESKTOP_CONTROL}${path}`,
    method ? { method } : {},
  );
  if (!response.ok) return null;
  // A non-JSON or wrong-shaped body used to throw out of the readers and reject the panel's
  // poll. Reads answer null on failure, so malformed succeeds as missing.
  const body = (await response.json().catch(() => null)) as unknown;
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const holder = (body as { holder?: unknown }).holder;
  if (holder !== "bot" && holder !== "human") return null;
  // The desktop answers with who holds the wheel and since when. `requested` has no desktop
  // equivalent, so it is stated rather than left undefined: it is typed as required, and an
  // undefined boolean read as a decision is the sort of thing that shows a prompt nobody asked for.
  return { requested: false, ...(body as Omit<ControlState, "requested">) };
}

export function readControl(computerId: string) {
  return callControl(computerId, "/control");
}

export function takeControl(computerId: string) {
  return callControl(computerId, "/control/take", "POST");
}

export function releaseControl(computerId: string) {
  return callControl(computerId, "/control/release", "POST");
}

/**
 * Supply a secret synchronously and never echo the value back to the UI.
 *
 * The one call here that reports why it failed, because a person is waiting on the answer and a
 * silent failure would leave them typing into something that is not listening.
 */
export async function supplySecret(
  _computerId: string,
  text: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    /*
     * The per-person address, because `/api/computers/<botId>/human/secret` is on the unmounted
     * per-Bot router. See the note on `DESKTOP_CONTROL`.
     */
    const response = await tryClient(`${DESKTOP_CONTROL}/human/secret`, {
      method: "POST",
      body: { text },
    });
    if (response.ok) return { ok: true };
    const body = (await response.json().catch(() => null)) as {
      error?: string;
    } | null;
    return { ok: false, error: body?.error ?? "That could not be entered." };
  } catch {
    return {
      ok: false,
      error: "The assistant's computer could not be reached.",
    };
  }
}

/*
 * `sendHumanInput` USED TO BE HERE, and it is gone because it addressed a router that is not mounted.
 *
 * It forwarded a person's clicks, keys and scrolls to the machine over
 * `POST /api/computers/<botId>/human/:kind`, so that a person driving a remote desktop through a
 * stream had their input relayed by this server. There is no longer any need for it, and no longer any
 * route for it: the person now connects to the desktop over VNC and their input goes straight there,
 * which is both the reason the screen stopped feeling laggy and the reason this relay is obsolete.
 *
 * Left in place it would have been worse than dead — it fails silently by design, because the person
 * can see their own input fail, so a version of it pointing at nothing would type into a void and look
 * like a person whose clicks had stopped landing.
 */
