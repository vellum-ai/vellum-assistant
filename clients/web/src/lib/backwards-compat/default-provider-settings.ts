/**
 * Backwards-compat gate: default-provider settings surface.
 *
 * Vellum Assistant 0.10.8 added `GET/PUT /v1/config/llm/default-provider`
 * (the persisted `llm.defaultProvider` plus an availability status).
 * Older assistants 404 both routes, so the web app hides the "Default"
 * marker and "Set as default" action in the Providers modal and skips
 * the status query entirely — the modal behaves exactly as it did
 * before the feature.
 */
import { useAssistantSupports } from "@/lib/backwards-compat/utils";

const MIN_VERSION = "0.10.8";

export function useSupportsDefaultProviderSettings(): boolean {
  return useAssistantSupports(MIN_VERSION);
}
