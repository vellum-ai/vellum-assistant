/**
 * Backwards-compat gate: lazy LLM-context detail loading.
 *
 * Vellum Assistant 0.8.12 added `view=summary` on the llm-context list
 * endpoints plus the per-log `GET /v1/llm-request-logs/:id/context`
 * detail endpoint, letting the inspector fetch a light call list and
 * load the selected call's sections lazily.
 *
 * Assistants on 0.8.11 or older ignore the `view` param (lists keep
 * carrying full sections) and 404 the detail endpoint, so the web app
 * skips it entirely and uses the inline sections.
 */
import {
  assistantSupports,
  useAssistantSupports,
} from "@/lib/backwards-compat/utils";

const MIN_VERSION = "0.8.12";

export function useSupportsLlmContextSummaryView(): boolean {
  return useAssistantSupports(MIN_VERSION);
}

export function supportsLlmContextSummaryView(): boolean {
  return assistantSupports(MIN_VERSION);
}
