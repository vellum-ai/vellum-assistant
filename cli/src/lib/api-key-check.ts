import { LLM_PROVIDER_ENV_VAR_NAMES } from "../shared/provider-env-vars.js";

export interface ApiKeyCheckResult {
  hasKey: boolean;
}

/**
 * Returns true when a key value is a real credential rather than a placeholder.
 *
 * .env.example ships values like `sk-ant-...`, `sk-...`, and `...` to show
 * where credentials go. Any value containing `...` or that is empty is treated
 * as a placeholder that the user has not replaced yet.
 */
function isPlaceholder(value: string | undefined): boolean {
  if (!value || value.trim() === "") return true;
  if (value.includes("...")) return true;
  return false;
}

/**
 * Check whether at least one LLM provider API key is configured in the
 * current process environment.
 *
 * The CLI's job is to spawn the daemon and pass configuration via environment
 * variables — it does not read from the .vellum/ directory (see AGENTS.md).
 * Checking process.env is sufficient: the daemon forwards whatever is set
 * in the environment, so exporting a key before running `vellum hatch` is
 * the correct way to supply it.
 *
 * Uses the canonical LLM provider env-var catalog so the list stays in sync
 * automatically as new providers are added.
 */
export function checkProviderApiKey(): ApiKeyCheckResult {
  for (const envVar of Object.values(LLM_PROVIDER_ENV_VAR_NAMES)) {
    if (!isPlaceholder(process.env[envVar])) {
      return { hasKey: true };
    }
  }
  return { hasKey: false };
}
