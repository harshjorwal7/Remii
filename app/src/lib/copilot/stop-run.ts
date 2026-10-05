import { client } from "@/lib/client";

/**
 * Ask the runtime to end the run going on one thread.
 *
 * THE STOP THE SCREEN CAN SEE THE OUTCOME OF. The SDK's own stop is fired inside
 * `copilotkit.stopAgent` as a detached `fetch(...).catch(console.error)`, so a stop that never
 * reached the server — a 401 from the auth guard, a runtime that was restarting, a thread the
 * runner had already forgotten — looked exactly like one that worked. This awaits the same
 * thread-scoped endpoint (`POST /agent/:agentId/stop/:threadId`, no run id) so the caller can put
 * a real sentence on screen when it fails.
 *
 * IDEMPOTENT BESIDE THE SDK'S CALL. The runner refuses a second stop for a thread that already has
 * one pending (`InMemoryRunner.stop` returns early on `stopRequested`), and refusing here is not an
 * error: it is the same request arriving twice. The awaited result only distinguishes "the server
 * accepted the request" from "the request failed", which is all the screen needs.
 *
 * `encodeURIComponent` on both path segments, matching the SDK's own URL construction — a thread id
 * is opaque and an agent id can be namespaced.
 */
export async function stopChannelRun({
  agentId,
  threadId,
}: {
  agentId: string;
  threadId: string;
}): Promise<void> {
  await client(
    `/api/copilotkit/agent/${encodeURIComponent(agentId)}/stop/${encodeURIComponent(threadId)}`,
    {
      method: "POST",
      fallback: "The stop could not be sent.",
    },
  );
}
