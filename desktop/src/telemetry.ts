import { invoke } from "@tauri-apps/api/core";
import type { ModelChoice } from "./ProviderPicker";

export type SetupStep =
  | "welcome"
  | "harness"
  | "install"
  | "model"
  | "connect"
  | "ask";

const HARNESSES = {
  crewai: "crewai",
  llamaindex: "llamaindex",
  agno: "agno",
  langgraph: "langgraph",
  "google-adk": "google_adk",
  "pydantic-ai": "pydantic_ai",
  "microsoft-agent-framework": "microsoft_agent_framework",
  "claude-agent-sdk": "claude_agent_sdk",
  strands: "strands",
  ag2: "ag2",
  langroid: "langroid",
  mastra: "mastra",
} as const;

type Harness = (typeof HARNESSES)[keyof typeof HARNESSES];

export type SetupEvent =
  | { kind: "step_viewed"; step: SetupStep }
  | { kind: "harness_chosen"; harness: Harness }
  | {
      kind: "model_chosen";
      /*
       * `anthropic` IS A CLOSED CATEGORY, not an open string.
       *
       * The picker can produce `{ provider: "anthropic", login: "plan" | "api-key" }` (see
       * `recordedModel`), so excluding it made every Claude setup report no telemetry at all —
       * which is the shape of a bug that hides a second bug: the category was missing from the
       * union, so nothing type-checked a case that produced one.
       */
      provider: "openai" | "anthropic" | "compatible" | "none";
      credential_path: "subscription" | "api_key" | "none";
      custom_base_url: boolean;
    };

export function harnessChoiceEvent(id: string): SetupEvent | null {
  // Match values rather than indexing with an arbitrary string, including prototype keys.
  for (const [known, harness] of Object.entries(HARNESSES)) {
    if (id === known) return { kind: "harness_chosen", harness };
  }
  return null;
}

export function modelChoiceEvent(
  choice: ModelChoice | null,
): SetupEvent | null {
  if (choice === null) {
    return {
      kind: "model_chosen",
      provider: "none",
      credential_path: "none",
      custom_base_url: false,
    };
  }
  const { provider, login } = choice;
  /*
   * The two subscription providers are handled TOGETHER rather than as one case plus a twin.
   *
   * Both produce `login: "plan" | "api-key"` and both mean the same thing to this event, so listing
   * them separately is how one of them quietly stops being reported the next time the other is
   * edited.
   */
  if (
    (provider === "openai" || provider === "anthropic") &&
    (login === "plan" || login === "api-key")
  ) {
    return {
      kind: "model_chosen",
      provider,
      credential_path: login === "plan" ? "subscription" : "api_key",
      custom_base_url: Boolean(choice.baseUrl?.trim()),
    };
  }
  if (provider === "openai-compatible" && login === "endpoint") {
    return {
      kind: "model_chosen",
      provider: "compatible",
      credential_path: "api_key",
      custom_base_url: Boolean(choice.baseUrl?.trim()),
    };
  }
  return null;
}

export function recordSetupEvent(event: SetupEvent | null): void {
  if (event === null) return;
  // Native code owns validation, opt-out, and delivery. Analytics never gate setup.
  void invoke<void>("record_setup_event", { event }).catch(() => undefined);
}
