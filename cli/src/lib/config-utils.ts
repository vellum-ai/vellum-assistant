import { writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

/**
 * Convert flat dot-notation key=value pairs into a nested config object.
 *
 * e.g. {"llm.default.provider": "anthropic", "llm.default.model": "claude-opus-4-6"}
 *   → {llm: {default: {provider: "anthropic", model: "claude-opus-4-6"}}}
 */
export function buildNestedConfig(
  configValues: Record<string, string>,
): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  for (const [dotKey, value] of Object.entries(configValues)) {
    const parts = dotKey.split(".");
    let target: Record<string, unknown> = config;
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      const existing = target[part];
      if (
        existing == null ||
        typeof existing !== "object" ||
        Array.isArray(existing)
      ) {
        target[part] = {};
      }
      target = target[part] as Record<string, unknown>;
    }
    target[parts[parts.length - 1]] = value;
  }
  return config;
}

/**
 * Write arbitrary key-value pairs to a temporary JSON file and return its
 * path. The caller passes this path to the daemon via the
 * VELLUM_DEFAULT_WORKSPACE_CONFIG_PATH env var so the daemon can merge the
 * values into its workspace config on first boot.
 *
 * Keys use dot-notation to address nested fields. For example:
 *   "llm.default.provider" → {llm: {default: {provider: ...}}}
 *   "llm.default.model"    → {llm: {default: {model: ...}}}
 *
 * Returns undefined when configValues is empty (nothing to write).
 */
export function writeInitialConfig(
  configValues: Record<string, string>,
): string | undefined {
  if (Object.keys(configValues).length === 0) return undefined;

  const config = buildNestedConfig(configValues);
  const tempPath = join(
    tmpdir(),
    `vellum-default-workspace-config-${process.pid}-${Date.now()}.json`,
  );
  writeFileSync(tempPath, JSON.stringify(config, null, 2) + "\n");
  return tempPath;
}
