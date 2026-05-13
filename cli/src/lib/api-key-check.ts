import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface ApiKeyCheckResult {
  hasKey: boolean;
  /** Absolute path to the instance .env file (may or may not exist). */
  envPath: string;
}

/**
 * Parse a .env file into a key→value map.
 *
 * Handles the common subset used by this project:
 *   - KEY=value (no quotes)
 *   - # comment lines and blank lines are skipped
 */
function parseDotEnv(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (key) result[key] = value;
  }
  return result;
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
 * Check whether at least one LLM provider API key is configured for the given
 * local assistant instance.
 *
 * Checks (in priority order):
 *   1. `process.env.ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GEMINI_API_KEY`
 *   2. The same keys read from `<instanceDir>/.vellum/.env`
 *
 * Returns `hasKey: false` when none of the known provider keys is set to a
 * non-placeholder value so that callers can print a clear, actionable warning.
 */
export function checkProviderApiKey(instanceDir: string): ApiKeyCheckResult {
  const envPath = join(instanceDir, ".vellum", ".env");

  const PROVIDER_KEYS = [
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "GEMINI_API_KEY",
    "OLLAMA_API_KEY",
  ] as const;

  // Check the process environment first (the user may have exported a key).
  for (const key of PROVIDER_KEYS) {
    if (!isPlaceholder(process.env[key])) {
      return { hasKey: true, envPath };
    }
  }

  // Fall back to the instance .env file.
  if (existsSync(envPath)) {
    const parsed = parseDotEnv(readFileSync(envPath, "utf-8"));
    for (const key of PROVIDER_KEYS) {
      if (!isPlaceholder(parsed[key])) {
        return { hasKey: true, envPath };
      }
    }
  }

  return { hasKey: false, envPath };
}
