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
 * in the environment, so exporting a key before running `vellum wake` is the
 * correct way to supply it.
 */
export function checkProviderApiKey(): ApiKeyCheckResult {
  const PROVIDER_KEYS = [
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "GEMINI_API_KEY",
    "OLLAMA_API_KEY",
  ] as const;

  for (const key of PROVIDER_KEYS) {
    if (!isPlaceholder(process.env[key])) {
      return { hasKey: true };
    }
  }

  return { hasKey: false };
}
