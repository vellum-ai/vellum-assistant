/**
 * Backwards-compat gate: the default-provider settings surface (the
 * "Default" marker and "Set as default" action in the Providers modal).
 *
 * Driven by `GET/PUT /v1/config/llm/default-provider`, which first ships in
 * the assistant version below. Against an older assistant the GET 404s and
 * every "Set as default" PUT can only fail, so the controls are hidden
 * (never disabled) on the `false` branch — the older assistant has no
 * default-provider concept to manage.
 */
import { useAssistantSupports } from "./utils";

export const MIN_VERSION = "0.10.8";

export function useSupportsDefaultProvider(): boolean {
  return useAssistantSupports(MIN_VERSION);
}
