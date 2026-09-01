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
import {
  useAssistantScopedSupports,
  useAssistantSupports,
  useAssistantVersionKnownFor,
} from "@/lib/backwards-compat/utils";

const MIN_VERSION = "0.10.8";

export function useSupportsDefaultProviderSettings(): boolean {
  return useAssistantSupports(MIN_VERSION);
}

export interface DefaultProviderSettingsSupport {
  /** The gate itself, scoped to `assistantId`. */
  supported: boolean;
  /** False while no version has hydrated for `assistantId`. */
  versionKnown: boolean;
}

/**
 * The gate for a caller that reads it once and latches the branch.
 *
 * `useSupportsDefaultProviderSettings` answers `false` while the identity
 * store is still hydrating, which a surface that re-renders when the version
 * lands can act on. A one-shot decision cannot: it would take the "no such
 * routes" path and never look again. Such callers wait for `versionKnown`
 * before reading `supported`.
 */
export function useDefaultProviderSettingsSupport(
  assistantId: string | null | undefined,
): DefaultProviderSettingsSupport {
  return {
    supported: useAssistantScopedSupports(MIN_VERSION, assistantId),
    versionKnown: useAssistantVersionKnownFor(assistantId),
  };
}
