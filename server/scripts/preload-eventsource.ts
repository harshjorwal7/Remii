/**
 * Loaded before `src/index.ts`, to make module loading deterministic outside the tests.
 *
 * THE SAME SHIM AS `scripts/test-preload.ts`, AND FOR THE SAME REASON — see that file's note, which
 * is the fuller version of this one. `@modelcontextprotocol/sdk` does `require("eventsource")` from
 * its CommonJS build, and eventsource ships as ESM. Bun permits a CommonJS `require()` of an ESM
 * module only once something in the process has already evaluated it as ESM, so whether the server
 * starts depends on import order.
 *
 * WHY THE TESTS ALREADY WORKED AND THE SERVER DID NOT. `test-preload.ts` does this, and the test
 * suite loads it, so the suite had been fine for a long time. The dev and start commands load
 * nothing, so `src/index.ts` reached the SDK's CommonJS build with eventsource still unevaluated and
 * the process died at import with:
 *
 *     require() async module ".../eventsource/dist/index.js" is unsupported
 *
 * which reads like a Bun bug and is in fact exactly the documented restriction. Nothing about the
 * server had changed; the difference was that one entry point had a preload and the other did not.
 *
 * SO THIS IS THE SAME LINE, AND THE COST OF KEEPING IT IS A PRELOAD FLAG ON TWO COMMANDS. The
 * alternative — a version override, or a resolution plugin — is a real dependency change to work
 * around a package's packaging, and would have to be revisited when either package is upgraded.
 * This can be deleted the moment the SDK ships an ESM-safe `require` or Bun stops caring about the
 * order; the test preload and this one should go together.
 */
import "eventsource";
