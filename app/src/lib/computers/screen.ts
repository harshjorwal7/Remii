import { tryClient } from "@/lib/client";

/**
 * A handle on the person's live desktop.
 *
 * Not a frame, and that is the whole change. This used to return one base64 JPEG per poll, captured by
 * the server from a remote screenshot API — so the browser redrew a picture of a screen it could not
 * interact with, and every mouse move had to travel back to the server and out to the machine as
 * another round trip. Taking the wheel therefore felt like driving on ice.
 *
 * What the server hands over instead is a noVNC URL and a per-session password, and the browser
 * speaks RFB straight to the desktop. Frames cost only what changed, input goes to the machine without
 * passing through the server, and the latency is a property of the network rather than of how many
 * API calls a picture costs.
 */

/** The geometry the desktop actually reports, which is what a click's coordinates mean. */
export type DesktopGeometry = {
  width: number;
  height: number;
};

/**
 * One still frame of the desktop.
 *
 * NOT the live screen and not a cheaper version of it. The live stream is noVNC and sends only what
 * changed; a still is one full-resolution capture, used where there is no live stream to have — the
 * collapsed card beside a run, and the picture a finished turn keeps so zooming it shows what it did
 * rather than whatever the Bot has open now.
 *
 * Not cached. Frames are polled while somebody is watching and are stale the moment after they arrive,
 * so holding one in a query cache would mean serving a picture of a screen that has since moved.
 *
 * Fails closed, and says why: the screen going unavailable is something the person watching needs to
 * be told, and it is not a reason to tear down the panel they are watching it in.
 */
export type Screenshot = {
  base64: string;
  width: number;
  height: number;
  capturedAt: string;
  /**
   * The active page's URL, when there is one to report.
   *
   * Absent on the hosted desktop, which has no notion of an active URL — what is in front is whatever
   * window the Bot opened. The card treats absence as "there is a screen here" and shows the picture,
   * which is the safe direction: a wrongly-hidden screen looks broken, a wrongly-shown one does not.
   */
  url?: string;
};

export async function readScreenshot(
  _computerId: string,
): Promise<{ frame?: Screenshot; error?: string }> {
  const unavailable = "The screen is not available right now.";
  try {
    // The desktop, not a Bot's browser. The desktop belongs to whoever is signed in, so there is
    // nothing to name; `computerId` is kept so the callers and the poll loop are unchanged.
    const response = await tryClient(`/api/computers/desktop/screenshot`);
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as {
        error?: string;
      } | null;
      return { error: body?.error ?? unavailable };
    }
    const frame = parseScreenshot(await response.json().catch(() => null));
    return frame ? { frame } : { error: unavailable };
  } catch {
    return { error: unavailable };
  }
}

function parseScreenshot(body: unknown): Screenshot | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const frame = (body as { frame?: unknown }).frame ?? body;
  if (!frame || typeof frame !== "object" || Array.isArray(frame)) return null;
  const { base64, width, height, capturedAt, url } = frame as {
    base64?: unknown;
    width?: unknown;
    height?: unknown;
    capturedAt?: unknown;
    url?: unknown;
  };
  // A mistyped frame is refused HERE rather than reaching the viewer, where an unvalidated dimension
  // poisons every coordinate scaled from it.
  if (
    typeof base64 !== "string" ||
    !base64 ||
    typeof width !== "number" ||
    !Number.isFinite(width) ||
    width <= 0 ||
    typeof height !== "number" ||
    !Number.isFinite(height) ||
    height <= 0
  ) {
    return null;
  }
  return {
    base64,
    width,
    height,
    capturedAt:
      typeof capturedAt === "string" ? capturedAt : new Date().toISOString(),
    ...(typeof url === "string" ? { url } : {}),
  };
}

/**
 * Open the live screen.
 *
 * Fails closed, and says why: a screen going unavailable is something the person watching needs told,
 * and it is not a reason to tear down the panel they are watching it in. The caller decides whether to
 * retry.
 *
 * This DOES start the desktop, if it is paused, and that is deliberate. Pressing "Take control" is a
 * request to use the computer, and a person who is met with a spinner while their desktop comes back
 * concludes the product is broken rather than that it is waking up.
 *
 * `authKey` is the RFB password for this stream and not the E2B account key, which never leaves the
 * server. It is returned beside the URL rather than inside it, so it does not end up in a proxy log,
 * in browser history, or in a `Referer` header.
 */
export async function openDesktopStream(): Promise<{
  url: string;
  authKey: string;
  width: number;
  height: number;
}> {
  const response = await tryClient(`/api/computers/desktop/stream`);
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(body?.error ?? "This computer is not running.");
  }
  const body = (await response.json().catch(() => null)) as unknown;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("The screen could not be opened.");
  }
  const { url, authKey, width, height } = body as {
    url?: unknown;
    authKey?: unknown;
    width?: unknown;
    height?: unknown;
  };
  // Refused here rather than handed to noVNC, which would fail deep inside its own handshake with a
  // message naming a protocol rather than a missing field.
  if (typeof url !== "string" || !url.startsWith("https://")) {
    throw new Error("This computer is not running.");
  }
  if (typeof authKey !== "string" || !authKey) {
    throw new Error("This computer is not running.");
  }
  return {
    url,
    authKey,
    width: typeof width === "number" && width > 0 ? width : 1920,
    height: typeof height === "number" && height > 0 ? height : 1080,
  };
}

/**
 * The URL to hand a noVNC client, with the password attached.
 *
 * Assembled here rather than by the caller so there is exactly one place that knows how the password
 * travels, and so it happens at the last moment — the URL exists only inside the iframe that connects
 * with it and is not stored, rendered, or put anywhere a person could copy it out of.
 *
 * `host` and `port` are set explicitly rather than inherited. noVNC defaults to `window.location`'s
 * host when the page URL does not carry them, which would send the RFB traffic back through this
 * deployment's own origin instead of to E2B — and there is no route there, so it would simply never
 * connect. That failure looks exactly like a wrong password, which is why it is worth being explicit.
 */
export function vncUrlFor(session: { url: string; authKey: string }): string {
  const base = new URL(session.url);
  base.searchParams.set("password", session.authKey);
  base.searchParams.set("autoconnect", "true");
  base.searchParams.set("reconnect", "true");
  // `scale` fits the whole desktop into whatever space the panel has, rather than showing a
  // 1920-wide screen at native size inside a 900px column and making the person pan to see anything.
  base.searchParams.set("resize", "scale");
  return base.toString();
}

/** The frame a page was showing when a Bot opened it. */
export type PageFrame = { url: string; title: string | null; frame: string };

/**
 * What this turn had on screen when it opened its page, or nothing if it was never kept.
 *
 * Nothing here writes. The frame is taken on the server at the moment the navigation succeeds, which
 * is the only moment the screen is certainly showing the page that was asked for. Capturing it here
 * instead meant capturing it after the turn, from a computer other conversations are also driving,
 * and filing whatever it happened to show.
 */
export async function readPageFrame(
  computerId: string,
  toolCallId: string,
): Promise<PageFrame | null> {
  try {
    const response = await tryClient(
      `/api/computers/${computerId}/page-frame/${encodeURIComponent(toolCallId)}`,
    );
    if (!response.ok) return null;
    const body = (await response.json().catch(() => null)) as unknown;
    if (!body || typeof body !== "object" || Array.isArray(body)) return null;
    const frame = (body as { frame?: unknown }).frame;
    if (!frame || typeof frame !== "object" || Array.isArray(frame)) {
      return null;
    }
    const { frame: image } = frame as { frame?: unknown };
    if (typeof image !== "string" || !image) return null;
    return frame as PageFrame;
  } catch {
    // A missing picture is a smaller sentence, not a broken conversation.
    return null;
  }
}
