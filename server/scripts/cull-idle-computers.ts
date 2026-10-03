/**
 * The idle-sweep, retired.
 *
 * It used to notice which computers had gone idle and suspend whatever the pod could claim, driven by
 * a CronJob rather than a timer in the API so that replicas could not each decide to suspend the same
 * computer. All of that was written for the per-Bot sandbox provider.
 *
 * That provider is gone, and with it every provider behind `createComputerProvider` — the function now
 * throws by design, because the only computer this deployment has is an E2B desktop per Bot. So
 * there is nothing left for this script to suspend: `offerIdleComputers` and `suspendClaimedComputers`
 * both need a `ComputerProvider` that no longer has an implementation to construct.
 *
 * A E2B desktop stops itself instead. `E2B_AUTOSTOP_MINUTES` reaches the sandbox as
 * `autoStopInterval`, the disk survives the stop, and the next request starts it again — so idle
 * machines are already being reclaimed, and this sweep was the second mechanism doing the same job
 * with a lease queue around it.
 *
 * KEPT AS AN EXPLANATION, NOT AS A NO-OP. A CronJob left pointing at this path would fail on every
 * tick, and the failure is the only thing that will ever tell whoever deployed it that it is no longer
 * needed. Exiting non-zero with that sentence is the useful behaviour; exiting 0 would leave a job
 * that does nothing and looks healthy.
 */
import { loadConfig } from "../src/config";

const config = loadConfig(process.env);

const provider = config.computer?.provider ?? "none";

console.error(
  JSON.stringify({
    type: "computer-cull-retired",
    provider,
    error:
      "This sweep suspended per-Bot sandbox computers, and every provider it could suspend has been removed. A E2B desktop stops itself after E2B_AUTOSTOP_MINUTES, so this CronJob can be deleted from the deployment.",
  }),
);

process.exit(1);
