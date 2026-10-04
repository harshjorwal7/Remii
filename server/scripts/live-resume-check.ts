/**
 * Prove a PAUSED desktop comes back, against the live account.
 *
 * This is the live counterpart to `probe-e2b-desktop.ts`. The probe asks whether a fresh sandbox works;
 * this asks the question a real user actually hits: my desktop went to sleep, can I use it again, and
 * does it still have my files?
 *
 * That question was worth a script because the answer was once "no, and the error says so in a way
 * that describes the consequence rather than the cause". `ensureDesktop` returning a row over a
 * machine that would not accept a command produced a screen tool that said the desktop was
 * unreachable — true, and naming nothing. On E2B the resume is one `Sandbox.connect`, so the risk is
 * different but not zero: `autoResume` means the platform can wake a sandbox on its own, and a
 * resumed machine that reports as running while its display never came back would be the same
 * failure wearing a new hat.
 *
 * Leaves the sandbox running on purpose, and says so in the output: pausing it here would
 * under-charge by however long the script took, and the idle sweep is what is supposed to do that.
 */
import { Sandbox } from "@e2b/desktop";
import { createDatabase } from "../src/db/client";
import { captureScreenshot } from "../src/computer/e2b-desktop";
import type { E2BDesktopLike } from "../src/computer/e2b-desktop";
import { createComputerProvisioner } from "../src/computer/provisioner";
import { createUserComputerStore } from "../src/computer/user-computers";

const USER = process.argv[2];
const apiKey = process.env.E2B_API_KEY;
if (!USER || !apiKey) {
  console.error(
    "usage: bun live-resume-check.ts <userId>   (with E2B_API_KEY set)",
  );
  process.exit(2);
}

const database = createDatabase(process.env.DATABASE_URL!);
const store = createUserComputerStore(database);
const connection = { apiKey };

/*
 * Declared `never` so every caller below ends: without it TypeScript cannot see that the early
 * "nothing to resume" exit is final, and it spends the rest of the script defending against a null row
 * it can never actually reach.
 */
const finish = async (code: number, message: string): Promise<never> => {
  console.log(message);
  await database.$client.end({ timeout: 5 });
  process.exit(code);
  throw new Error("unreachable");
};

const row = await store.get(USER);
if (!row?.sandboxId) {
  console.log(`no sandbox on this user's row — nothing to resume`);
  await database.$client.end({ timeout: 5 });
  process.exit(1);
}

const sandboxId: string = row.sandboxId;
const infoBefore = await Sandbox.getInfo(sandboxId, connection);
console.log(`row status=${row.status}  sandbox state=${infoBefore.state}`);

if (infoBefore.state === "running") {
  console.log(
    "already running — this proves nothing. Pause it first, or wait for the idle sweep.",
  );
  await database.$client.end({ timeout: 5 });
  process.exit(1);
}

console.log("\ncalling ensureDesktop() on a paused sandbox…");
const provisioner = createComputerProvisioner(store, {
  apiKey,
  autoStopMinutes: Number(process.env.E2B_AUTOSTOP_MINUTES ?? 10),
  ...(process.env.E2B_WORKSPACE_MOUNT
    ? { workspaceMountPath: process.env.E2B_WORKSPACE_MOUNT }
    : {}),
});

const started = Date.now();
const startedRow = await provisioner.ensureDesktop({ key: USER, userId: USER });
const elapsed = Date.now() - started;
console.log(
  `ensureDesktop resolved in ${elapsed}ms, status=${startedRow.status}`,
);

const infoAfter = await Sandbox.getInfo(sandboxId, connection);
console.log(`sandbox state now=${infoAfter.state}`);

const sandbox = (await Sandbox.connect(
  sandboxId,
  connection,
)) as unknown as E2BDesktopLike;

const size = await sandbox.getScreenSize();
console.log(
  `display=${size.width}x${size.height}  row says=${startedRow.displayWidth}x${startedRow.displayHeight}`,
);

/*
 * Two questions, and the second is the one the volume exists for. A resumed desktop with an empty
 * `/workspace` is a desktop that came back and forgot everything, which is worse than one that
 * plainly did not come back because it looks working.
 */
const listed = await sandbox.commands.run(
  "ls -A /workspace 2>/dev/null | head -20 || true",
  {
    timeoutMs: 30_000,
  },
);
console.log(
  `/workspace after resume -> ${listed.stdout.trim().split("\n").filter(Boolean).length} entries`,
);

const shot = await captureScreenshot(sandbox);
console.log(
  `screenshot -> ${shot ? `${shot.data.length} base64 chars` : "NONE"}`,
);

const woke = infoAfter.state === "running";
await finish(
  woke && shot ? 0 : 1,
  `\nRESULT: ${
    woke && shot
      ? `the desktop woke in ${elapsed}ms and painted`
      : "STILL BROKEN — the desktop did not wake, or woke with no screen"
  }`,
);
