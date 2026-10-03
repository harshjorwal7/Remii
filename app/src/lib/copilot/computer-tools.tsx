import { useFrontendTool } from "@copilotkit/react-core/v2";
import { z } from "zod";
import { tryClient } from "@/lib/client";
import { useActiveBotHolder } from "./active-bot";

/**
 * The frontend computer tools, and why there is only one left.
 *
 * THIS FILE USED TO REGISTER FOURTEEN, AND EVERY ONE OF THEM WAS BROKEN.
 *
 * All of them called `/api/computers/<botId>/…` — the per-Bot browser surface that existed when a
 * computer was a Chromium container per Bot. A computer is now a hosted desktop belonging to a
 * PERSON, that per-Bot router is not mounted at all, and every one of those calls answered 404.
 *
 * What a model saw, therefore, was a tool list containing `computer_navigate`, `computer_click`,
 * `computer_type`, `computer_key`, `computer_scroll`, `computer_read`, `computer_snapshot`,
 * `computer_list_files`, `computer_read_file`, `computer_write_file`, `computer_run_command` and
 * `computer_request_help` — names that all look exactly like the working ones and are all wired to
 * nothing. It called them. They failed. And the failure said:
 *
 *     {"ok":false,"reason":"That did not work."}
 *
 * which names nothing, distinguishes nothing, and is identical for a 404, a 500, a refused policy
 * and a computer that is genuinely off. So the model, unable to tell a missing route from a dead
 * machine, tried the same wrong names again and again, and eventually told the person:
 *
 *     "The computer itself isn't responding… I can't start it from my side."
 *
 * That was not a diagnosis. Every one of those calls was failing because the button was not wired to
 * anything, and the actual computer was working the whole time. The server's own tools
 * (`computer_shell`, `computer_screen`, `computer_screenshot`, …) were fine and had been all along —
 * the frontend list simply shadowed them and won.
 *
 * SO: the desktop tools are dispatched by the SERVER (`desktopToolsFor` in
 * `server/src/computer/desktop-tools.ts`), where the machine is actually reachable and where the
 * grant, the policy and the audit row already are. A frontend copy of a tool that needs a round trip
 * to the machine is a second implementation of the same thing that can drift from the first and did,
 * and this file is the proof.
 *
 * What legitimately stays here is the one tool that is genuinely the BROWSER's to answer: it writes
 * an audit row about the Bot's own decision and touches nothing on the computer. Everything else now
 * has exactly one implementation, and it is the one that works.
 */

/**
 * Self-reported model declines: audit evidence, not an enforcement control.
 *
 * The only tool left in this file, and it is here for a specific reason rather than by omission: it
 * records something about the MODEL's choice — that it declined something it was asked to do — and
 * there is no computer, no screen and no person involved. It posts to an agent route that exists, and
 * it deliberately fails soft, because an audit note must never be the reason a Bot goes silent.
 */
export function ComputerTools() {
  const bot = useActiveBotHolder();

  useFrontendTool({
    available: true,
    name: "report_refusal",
    description:
      "Record that you DECLINED something you were asked to do, because it looked unsafe, was outside " +
      "what you are for, or you judged you should not. Call this whenever you say no to a request, in " +
      "addition to telling the person. It changes nothing about your answer; it exists for audit " +
      "purposes. Do not call it when you simply could " +
      "not do something, only when you chose not to.",
    parameters: z.object({
      reason: z
        .string()
        .describe("Why you declined, in one sentence and in your own words"),
      request: z
        .string()
        .optional()
        .describe("What you were asked to do, in a few words"),
    }),
    handler: async (
      input: { reason: string; request?: string },
      { signal }: { signal?: AbortSignal } = {},
    ) => {
      try {
        const response = await tryClient(
          `/api/agents/${encodeURIComponent(bot.current)}/declined`,
          { method: "POST", body: input, signal },
        );
        return response.ok
          ? "Recorded. Now tell the person what you decided and why."
          : "That could not be recorded. Tell the person what you decided anyway.";
      } catch {
        // Audit bookkeeping must not prevent the Bot from answering.
        return "That could not be recorded. Tell the person what you decided anyway.";
      }
    },
    render: () => null,
  });

  // Registers tools; renders nothing. The `null` is what makes this a valid component, and it is
  // here rather than implied because a function component returning `void` is a type error that has
  // nothing to do with anything a reader would think to check.
  return null;
}
