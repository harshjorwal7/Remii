/**
 * E2B, held server-side and nowhere else.
 *
 * This replaces the Daytona module it is modelled on, and two of the reasons it existed at all went
 * away with that platform rather than with this file:
 *
 *  - Daytona free-tier sandboxes have no internet egress, so a Bot's browser could not load a page.
 *    E2B sandboxes do have it. Probed against the live account: `curl https://example.com` answers
 *    `200` and `getent hosts example.com` resolves, from inside the sandbox.
 *  - Daytona's preview proxy answered 401 for every token form and its SDK ships no port tunnel, so
 *    noVNC could not be reached from a browser. E2B exposes the sandbox's own port
 *    (`sandbox.getHost(6080)`), so a real VNC stream is reachable. That is the difference between a
 *    sampled 8fps JPEG screen and an actual desktop, and it is why the live screen here is a noVNC
 *    client rather than a frame loop.
 *
 * The key never reaches React. That is the whole reason this module exists rather than the SDK being
 * constructed where it is used: a browser is a place a deployment token must never be, and the
 * browser already asks this server for the user's computer, so everything needed to answer that is
 * on this side of the line.
 *
 * What DOES reach the browser is a per-session VNC password for one desktop, minted by
 * `stream.start({ requireAuth: true })` and rotated every time the stream is started. That is a
 * materially smaller thing to leak than an account key — it buys control of one desktop until it is
 * restarted, and nothing else — but it is still a credential and is treated as one.
 */
import { createHash } from "node:crypto";
import { Sandbox, Volume } from "@e2b/desktop";

/**
 * Where a person's files live inside the sandbox, and where a tool's relative path is resolved.
 *
 * One definition, because these must be the same path: the mount point is where the volume appears,
 * and path resolution is what makes `notes.md` mean `/workspace/notes.md`. Two constants that
 * happened to agree until somebody changed one is exactly the bug this note exists to prevent.
 */
export const WORKSPACE_DIR = "/workspace";

/**
 * Opaque id for a person's computer.
 *
 * A hash of the user id, not the user id. E2B surfaces metadata and volume names in its dashboard,
 * its API responses and anything that logs a sandbox list, and a name that reads as somebody's own
 * id is a name that tells an operator which row a machine belongs to without the server having to
 * look anything up.
 */
export function sandboxKeyFor(userId: string): string {
  let hash = 5381;
  for (let index = 0; index < userId.length; index += 1) {
    hash = ((hash << 5) + hash + userId.charCodeAt(index)) >>> 0;
  }
  const slug = userId
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .slice(0, 20);
  return `${slug || "u"}-${hash.toString(36)}`;
}

/**
 * The volume one person's files live on.
 *
 * A volume per person rather than one volume for everybody, which is the opposite of what Daytona
 * did and is deliberate: Daytona mounted a single shared volume at a per-user subpath and relied on
 * the FUSE mount being scoped to that prefix for isolation. E2B volumes are addressed by name and
 * mounted whole, with no equivalent scoping, so a shared volume would mean every person's desktop
 * sitting on one directory. There is no subpath trick available to fix that afterwards, which is why
 * this is one volume per person and not a naming convention inside one.
 *
 * The name is opaque for the same reason {@link sandboxKeyFor} is: this string is the name of a
 * person's persistent data, and it appears in an operator's volume list.
 *
 * Recomputable, which is the property that matters: a row deleted by mistake still finds its disk.
 */
export function volumeNameFor(userId: string): string {
  return `remii-user-${sandboxKeyFor(userId)}`;
}

export type E2BClientOptions = {
  apiKey: string;
  /**
   * The API root. Optional because E2B's own default is right for the hosted product, and naming it
   * is only needed for a self-hosted control plane — which was a Daytona-only concept and has no
   * E2B equivalent worth inventing.
   */
  apiUrl?: string;
  domain?: string;
};

/**
 * The connection options every sandbox call needs, in one place.
 *
 * E2B's SDK takes its credentials per call rather than through a constructed client, so "the client"
 * here is this function. Holding it means a deployment's key is read from one expression rather than
 * threaded through every call site, and it is what lets the tests swap the whole platform for a stub
 * by replacing one module.
 */
export function e2bConnection(options: E2BClientOptions) {
  return {
    apiKey: options.apiKey,
    ...(options.apiUrl ? { apiUrl: options.apiUrl } : {}),
    ...(options.domain ? { domain: options.domain } : {}),
  };
}

/**
 * Metadata on every sandbox this deployment creates.
 *
 * The point is reconciliation: an operator holding an E2B sandbox can tell which database row claims
 * it, and a row can be matched to its machine without a lookup through the API. `computer` is the
 * opaque id from {@link sandboxKeyFor}, never anything about the person — a dashboard is not the place
 * to discover who somebody is.
 *
 * `computer_type` says `per-person` because one person owns one computer, which is what this is.
 */
export function metadataFor(
  userId: string,
  environment: string,
): Record<string, string> {
  return {
    app: "remii",
    provider: "e2b",
    computer: sandboxKeyFor(userId),
    computer_type: "per-person",
    environment,
  };
}

/**
 * E2B's own desktop template, used when no other is named.
 *
 * `Sandbox.create()` with no template resolves to this, and it is not a convenience: it is the only
 * thing that makes a screen exist. Probed against the live account — a sandbox from it comes up with
 * `Xvfb :0`, XFCE, x11vnc, noVNC, xdotool, scrot, ffmpeg, Google Chrome 150 and Python 3.10 on
 * Ubuntu 22.04, and `getScreenSize()` reports the resolution asked for. Every one of those is
 * something the desktop and the tools need; nothing had to be added to it.
 *
 * Worth stating because the account this was built on reported `GET /templates -> []`, which reads
 * like "there is no desktop template available". There is not a CUSTOM one; the built-in is not
 * listed by that endpoint and does not need to be.
 */
export const DEFAULT_DESKTOP_TEMPLATE = "desktop";

/**
 * The resolution the product commits to.
 *
 * Read back from the running desktop rather than assumed — `getScreenSize()` is what a click's
 * coordinates are interpreted against, so guessing here would mean a click at (800,600) meaning one
 * thing on this machine and something else on another.
 *
 * 1920x1080 rather than smaller, which is the opposite of what the sampled-JPEG screen wanted. Those
 * frames were sent whole, every frame, so pixels cost bandwidth per frame and 1080p was unaffordable.
 * A VNC stream sends only the rectangles that changed, so the cost tracks what is happening on the
 * screen rather than how large it is, and the full-size desktop is now free.
 */
export const DESKTOP_RESOLUTION = { width: 1920, height: 1080 } as const;

/**
 * The noVNC port inside the sandbox.
 *
 * x11vnc listens on 5900 and websockify — which is what `sandbox.stream` starts — serves noVNC on
 * 6080. 6080 is the port E2B's proxy is asked to expose, and it is the same port in every sandbox,
 * because `@e2b/desktop` runs noVNC there by default.
 */
export const NOVNC_PORT = 6080;

/**
 * The RFB port x11vnc serves inside the sandbox.
 *
 * Not exposed to a browser and never proxied — E2B's proxy exposes {@link NOVNC_PORT}, which
 * websockify then forwards to this. It is named because `stream.start` takes both, and naming one
 * without the other leaves a reader wondering which port is the real one.
 */
export const VNC_PORT = 5900;

/**
 * The RFB password for one person's desktop.
 *
 * DERIVED, NOT GENERATED, AND THE REASON IS A BUG THAT COST THE WHOLE FEATURE.
 *
 * `@e2b/desktop` generates a password inside `stream.start()` and keeps it on that one `VNCServer`
 * object, which is readable only through `stream.getAuthKey()` on that same object. But every
 * `Sandbox.connect()` builds a FRESH `VNCServer`. So the first call opened the screen and set the
 * password; the second call found x11vnc already running, correctly treated that as fine — and then
 * asked a brand-new object for a password it had never been given, which threw
 * "Unable to retrieve stream auth key". Open the screen once and it worked. Open it again and it did
 * not, which read as "the live screen is not visible" and "take control doesn't work" rather than as a
 * missing field.
 *
 * So the password is computed from the user id instead, which makes it a property of the DESKTOP
 * rather than of a connection to it: stable across calls, across tabs, and across a restart of this
 * process. Recomputable rather than stored, for the same reason the volume name is — a row lost by
 * mistake must not lock somebody out of their own desktop, and there is no column to lose.
 *
 * WHAT THIS COSTS, STATED PLAINLY. It is not a random secret: anybody who knows the user id can derive
 * it. That is acceptable here because the user id is itself an opaque secret, it never reaches the
 * browser, and the sandbox's hostname — without which there is nothing to connect to — is only ever
 * learned through the API this same key authorises. It is nonetheless strictly weaker than a stored
 * random value, and if this ever needs to be a real secret rather than a derived one, the place to put
 * it is a column on the row and this function becomes a read.
 */
export function vncPasswordFor(userId: string): string {
  const digest = createHash("sha256")
    .update(`remii-vnc:${userId}`)
    .digest("base64url");
  // 16 characters: x11vnc truncates at 8, so anything longer buys nothing, and noVNC puts it in a URL
  // where every character is a chance to be mangled in a log.
  return digest.slice(0, 16);
}

export { Sandbox, Volume };
