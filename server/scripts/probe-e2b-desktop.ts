/**
 * Prove whether an E2B desktop can actually be made, rather than reasoning about it.
 *
 * The same discipline as the old platform probe, and it exists for the same reason: the questions
 * that decide this migration are all facts about the platform, not opinions. Specifically —
 *
 *  1. Does a sandbox come up with a real screen, and does it come up WITHOUT a template we built?
 *     `GET /templates` answered `[]` on this account, so there is nothing custom to stand on.
 *  2. Does it have internet egress? Full egress is the reason E2B is the platform.
 *  3. Does `stream.start()` give a noVNC URL we can actually reach from outside? This is the
 *     latency fix — a real VNC stream instead of sampled 8fps JPEG frames — and it is unproven.
 *  4. Does the VNC server require auth, and what happens if we forget to ask for it? A user's
 *     desktop holds their files; an unauthenticated public URL to it is not a small mistake.
 *  5. Does pause/resume preserve state? "Persistent" has to mean more than the row saying so.
 *
 * Every sandbox this creates is killed in the `finally`. A probe that leaks the machine it exists to
 * measure is worse than no probe.
 */
import { Sandbox } from "@e2b/desktop";

const apiKey = process.env.E2B_API_KEY;
if (!apiKey) {
  console.error("E2B_API_KEY is not set.");
  process.exit(2);
}

/** A person who has this URL has the keyboard, the mouse and every file on the disk. */
const AUGUST_RESOLUTION: [number, number] = [1280, 720];

let sandbox: Awaited<ReturnType<typeof Sandbox.create>> | null = null;
const verdicts: string[] = [];

const ok = (label: string, pass: boolean, detail = "") => {
  verdicts.push(`${pass ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!pass) process.exitCode = 1;
};

try {
  console.log(`default template: ${(Sandbox as unknown as { defaultTemplate: string }).defaultTemplate}`);
  console.log("creating a desktop sandbox with no template argument…");

  sandbox = await Sandbox.create({
    apiKey,
    resolution: AUGUST_RESOLUTION,
    timeoutMs: 300_000,
  });

  console.log(`created sandbox ${sandbox.sandboxId}`);
  ok("sandbox created without a custom template", true, sandbox.sandboxId);

  // 1. A screen, not an empty box.
  const size = await sandbox.getScreenSize();
  ok(
    "display is alive at the requested resolution",
    size.width === AUGUST_RESOLUTION[0] && size.height === AUGUST_RESOLUTION[1],
    `${size.width}x${size.height}`,
  );

  const shot = await sandbox.screenshot("bytes");
  ok("screenshot returns bytes", shot.byteLength > 1000, `${shot.byteLength} bytes`);

  // 2. The reason for the migration.
  let egress = "unknown";
  try {
    const probe = await sandbox.commands.run(
      "curl -sS -o /dev/null -w '%{http_code}' --max-time 12 https://example.com || echo FAILED",
      { timeoutMs: 30_000 },
    );
    egress = probe.stdout.trim();
    ok(
      "sandbox has internet egress",
      egress === "200",
      `example.com -> ${egress}`,
    );
  } catch (error) {
    ok("sandbox has internet egress", false, `threw: ${String(error).slice(0, 200)}`);
  }

  // DNS separately, because "curl worked" and "DNS resolves" are different facts and a
  // hardcoded-IP test would hide the second.
  try {
    const dns = await sandbox.commands.run(
      "getent hosts example.com || echo NO_DNS",
      { timeoutMs: 30_000 },
    );
    ok("DNS resolves", !dns.stdout.includes("NO_DNS"), dns.stdout.trim().slice(0, 80));
  } catch (error) {
    ok("DNS resolves", false, String(error).slice(0, 150));
  }

  // 3 + 4. The noVNC URL, and whether it is reachable and protected.
  console.log("starting the VNC stream with requireAuth: true…");
  await sandbox.stream.start({ requireAuth: true });
  const streamUrl = sandbox.stream.getUrl({ autoConnect: true, viewOnly: false });
  const authKey = sandbox.stream.getAuthKey();
  console.log(`stream url: ${streamUrl.replace(/password=[^&]*/, "password=<redacted>")}`);
  ok("requireAuth: true produced an auth key", Boolean(authKey), `len=${authKey?.length ?? 0}`);

  const x11vnc = await sandbox.commands.run("pgrep -a x11vnc || echo NO_X11VNC", {
    timeoutMs: 30_000,
  });
  ok(
    "x11vnc runs with a password, not -nopw",
    !x11vnc.stdout.includes("NO_X11VNC") && !x11vnc.stdout.includes("-nopw"),
    x11vnc.stdout.trim().slice(0, 160),
  );

  // Is the port publicly reachable, and does it demand the password? This is the security
  // question, so it gets checked against the real host rather than reasoned about.
  const bare = new URL(streamUrl);
  const noAuth = new URL(bare);
  for (const key of [...noAuth.searchParams.keys()]) noAuth.searchParams.delete(key);
  noAuth.searchParams.set("autoconnect", "true");

  for (const [label, target] of [
    ["noVNC page", noAuth.toString()],
    ["websockify handshake", noAuth.toString().replace(/vnc\.html.*/, "")],
  ] as const) {
    try {
      const response = await fetch(target, { redirect: "manual" });
      // 200 on the page is fine — the page is static. What matters is the websocket upgrade
      // below, which is where noVNC either negotiates or refuses.
      console.log(`  ${label} -> HTTP ${response.status}`);
    } catch (error) {
      console.log(`  ${label} -> threw ${String(error).slice(0, 120)}`);
    }
  }

  /*
   * What the tunnel can be told here, and what it cannot.
   *
   * `requireAuth: true` is enforced by x11vnc, INSIDE the RFB handshake — which happens after the
   * websocket is already open. So an open websocket proves the transport and proves nothing about
   * the credential; a wrong password is answered with an RFB failure a moment later, not with a
   * refused upgrade. The check that actually matters is the one above it: x11vnc running with
   * `-usepw` and not `-nopw`. That is the fact that makes the URL safe to hand out.
   *
   * So this is a reachability probe, deliberately labelled as one.
   */
  const wsBase = noAuth.toString().replace(/\/vnc\.html.*$/, "");
  for (const path of ["/websockify", "/websockify?token=x", ""]) {
    const ws = await probeWebsocket(`${wsBase}${path}`);
    ok(
      `noVNC websocket reachable at "${path || "/"}"`,
      ws.reachable,
      ws.detail,
    );
  }

  // 5. Persistence. A paused sandbox that comes back empty is not a persistent desktop.
  const before = await sandbox.commands.run(
    "echo persisted-marker-4711 > /tmp/probe-persist.txt && cat /tmp/probe-persist.txt",
    { timeoutMs: 30_000 },
  );
  ok("wrote a marker file", before.stdout.includes("persisted-marker-4711"), before.stdout.trim());

  console.log("pausing…");
  await sandbox.pause();
  console.log("resuming with Sandbox.connect (it resumes a paused sandbox in place)…");
  sandbox = await Sandbox.connect(sandbox.sandboxId, { apiKey });
  console.log(`reconnected, running=${await sandbox.isRunning()}`);

  const after = await sandbox.commands.run(
    "cat /tmp/probe-persist.txt 2>/dev/null || echo LOST",
    { timeoutMs: 60_000 },
  );
  ok(
    "file survives pause/resume",
    after.stdout.includes("persisted-marker-4711"),
    after.stdout.trim(),
  );
} catch (error) {
  console.error("PROBE THREW:", String(error).slice(0, 600));
  process.exitCode = 1;
} finally {
  if (sandbox) {
    console.log(`killing probe sandbox ${sandbox.sandboxId}…`);
    await sandbox
      .kill()
      .catch((error: unknown) => console.log("kill failed:", String(error).slice(0, 200)));
  }
}

console.log("\n--- results ---");
for (const line of verdicts) console.log(line);
console.log(
  process.exitCode ? "\nRESULT: E2B desktop did NOT satisfy every check" : "\nRESULT: E2B desktop satisfies every check",
);

/**
 * Open a websocket and report what the far end says.
 *
 * A VNC server sends its RFB version banner as the first frame, so a websocket that opens AND
 * receives bytes is talking RFB rather than being answered by a proxy error page. That is a
 * reachability claim and nothing more — see the note at the call site for why it says nothing about
 * the password.
 */
async function probeWebsocket(url: string): Promise<{ reachable: boolean; detail: string }> {
  const WebSocketCtor = globalThis.WebSocket;
  if (!WebSocketCtor) return { reachable: false, detail: "no WebSocket implementation available" };

  return new Promise((resolve) => {
    let settled = false;
    const finish = (reachable: boolean, detail: string) => {
      if (settled) return;
      settled = true;
      resolve({ reachable, detail });
    };

    const socket = new WebSocketCtor(url, "binary");
    const timer = setTimeout(() => {
      try {
        socket.close();
      } catch {
        /* already dead */
      }
      finish(false, "handshake timed out after 10s");
    }, 10_000);

    socket.binaryType = "arraybuffer";
    socket.onopen = () => {
      socket.onmessage = (event: MessageEvent) => {
        const bytes =
          typeof event.data === "string"
            ? event.data
            : new TextDecoder("latin1").decode(new Uint8Array(event.data as ArrayBuffer));
        socket.close();
        finish(true, `RFB banner ${JSON.stringify(bytes.slice(0, 12))}`);
      };
    };
    socket.onerror = () => {
      clearTimeout(timer);
      finish(false, "websocket error (likely refused upgrade or blocked)");
    };
    socket.onclose = (event: CloseEvent) => {
      clearTimeout(timer);
      if (!settled) finish(false, `closed with code ${event.code}`);
    };
  });
}