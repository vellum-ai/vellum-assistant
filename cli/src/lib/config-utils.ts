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
 * Ensure hatch always provides enough initial LLM config for the assistant to
 * detect a fresh off-platform hatch and seed BYOK profiles.
 *
 * @deprecated Part of the workspace-config overlay path — a CLI→Assistant
 * side channel that bypasses the Assistant's public APIs and has no
 * equivalent in web/desktop. Two replacement paths are on the table:
 *
 *   1. Post-hatch API calls — the CLI calls public Assistant routes after
 *      boot (`POST /v1/secrets`, plus a small read-only endpoint that
 *      returns the canonical inference-profile templates so the CLI can
 *      PATCH them in). See the closed alternatives in PR #32061 and
 *      PR #32131 for the shape this would take.
 *   2. Move inference-profile seeds out of workspace config and into
 *      Assistant code, so there is nothing for the CLI to inject in the
 *      first place.
 *
 * Either path removes the need for this helper.
 */
export function buildHatchConfigValues(
  configValues: Record<string, string>,
  provider: string | null | undefined,
): Record<string, string> {
  if (!provider || configValues["llm.default.provider"]) {
    return configValues;
  }

  return {
    ...configValues,
    "llm.default.provider": provider,
  };
}

/**
 * Write arbitrary key-value pairs to a temporary JSON file and return its
 * path. The caller is responsible for getting the file to the daemon — for
 * the local hatch flow that means setting `VELLUM_DEFAULT_WORKSPACE_CONFIG_PATH`
 * on the daemon process; for the Docker hatch flow the caller stages the
 * file into the workspace volume so the rename-after-consume step in
 * `mergeDefaultWorkspaceConfig` is a same-filesystem rename.
 *
 * Keys use dot-notation to address nested fields. For example:
 *   "llm.default.provider" → {llm: {default: {provider: ...}}}
 *   "llm.default.model"    → {llm: {default: {model: ...}}}
 *
 * Returns undefined when configValues is empty (nothing to write).
 *
 * @deprecated See {@link buildHatchConfigValues} for the replacement
 * direction. This overlay path is a CLI→Assistant side channel and will be
 * removed once one of the documented replacements lands.
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
