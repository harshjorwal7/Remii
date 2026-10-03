import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * What the retired sweep says, asserted against the script's own source.
 *
 * WAS two cases about the windows the sweep handed `purge` — the finished-suspension idle window and
 * the longer give-up window — checked as two lines of the script's text.
 *
 * Both lines are gone with the sweep. Every provider behind `createComputerProvider` was removed, so
 * `offerIdleComputers` and `suspendClaimedComputers` have nothing to suspend and the script does not
 * run a queue at all: it prints why the CronJob should be deleted and exits non-zero, on purpose, so
 * a job still pointing at this path fails loudly instead of looking healthy.
 *
 * That last behaviour is the one thing worth pinning, and it is why these are not simply deleted. A
 * sweep that could succeed and did nothing would be the dangerous shape; a sweep that fails saying
 * why is the useful one, and a rename of the script or a change to that exit code should fail here
 * rather than in production.
 *
 * The script still cannot be imported to be tested — it calls `loadConfig` and `process.exit` at the
 * top level — so this remains a read of its source.
 */
const script = readFileSync(
  join(import.meta.dir, "..", "scripts", "cull-idle-computers.ts"),
  "utf8",
);

test("the retired sweep says which job should be deleted and by what name", () => {
  // Names the CronJob's own path, so whoever deployed it can act on the sentence rather than guess.
  expect(script).toContain('type: "computer-cull-retired"');
  expect(script).toContain("can be deleted from the deployment");
});

test("it exits non-zero rather than succeeding at nothing", () => {
  /*
   * THE ASSERTION THAT MATTERS. Exit 0 would leave a scheduled job that succeeds forever, does
   * nothing, and is indistinguishable from one that reclaimed yesterday's machines. A non-zero exit is
   * the only thing that will ever surface this to whoever deployed it.
   */
  expect(script).toContain("process.exit(1)");
  expect(script).not.toContain("process.exit(0)");
});

test("it names the mechanism that replaced it", () => {
  // Otherwise the sentence reads as "the sweep was removed" and invites putting it back.
  expect(script).toContain("E2B_AUTOSTOP_MINUTES");
});
