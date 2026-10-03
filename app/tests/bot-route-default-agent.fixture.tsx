import { mock } from "bun:test";
import * as ReactCoreV2 from "@copilotkit/react-core/v2";
import * as activeBot from "@/lib/copilot/active-bot";
import * as botThread from "@/lib/copilot/bot-thread";
import * as stoppedTurn from "@/lib/copilot/stopped-turn";

/*
 * Every mock below is ADDITIVE, and that is the whole point of this header.
 *
 * A `mock.module` whose factory returns a bare object REPLACES the module: every export it does
 * not mention stops existing, for every other test file in the process. That is not a hazard for
 * the file doing the mocking, whose own imports it controls, and it is a real one for everyone
 * else.
 *
 * It already cost two tests. `component-preview.test.tsx` spies on
 * `OpenGenerativeUIActivityRenderer` in `@copilotkit/react-core/v2`; this fixture replaced that
 * module with a single `CopilotChat`, so the spy found nothing to spy on and the renderer
 * assertions failed — but only in a full run, which is the worst shape of failure to diagnose. The
 * test passed alone and looked fine forever.
 *
 * So each factory spreads the real module and overrides one export. The mock then states what it
 * means: "this component is this, for this test" — instead of quietly deleting everything else in
 * the file's vicinity.
 */
mock.module("@copilotkit/react-core/v2", () => ({
  ...ReactCoreV2,
  CopilotChat: ({ agentId }: { agentId: string; threadId?: string }) => (
    <div data-agent-id={agentId} data-testid="copilot-chat" />
  ),
}));

mock.module("@/lib/copilot/active-bot", () => ({
  ...activeBot,
  useActiveBot: () => undefined,
}));

mock.module("@/lib/copilot/bot-thread", () => ({
  ...botThread,
  useBotThread: (agentId: string) => ({
    history: "ready",
    startNew: () => undefined,
    threadId: `thread-${agentId}`,
  }),
}));

mock.module("@/lib/copilot/stopped-turn", () => ({
  ...stoppedTurn,
  useStoppedTurn: () => null,
}));
