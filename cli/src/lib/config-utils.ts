import { existsSync, mkdirSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

/**
 * Tmp dir for the hatch-time workspace-config overlay that gets bind-mounted
 * into the assistant container.
 *
 * Why not `os.tmpdir()`? On macOS that resolves to `/var/folders/...`, which
 * Colima's default virtiofs share does NOT expose to the Linux VM (only
 * `/Users/...` is shared by default). Docker then bind-mounts a non-existent
 * source — and on bind-mount-source-missing, Docker silently creates the
 * destination inside the container as an empty directory. The daemon's
 * overlay loader (`mergeDefaultWorkspaceConfig`) then hits EISDIR on
 * `readFileSync`, returns `hadOverlay: false`, and the BYOK profile seeding
 * silently skips — leaving fresh BYOK hatches on macOS Colima with
 * `activeProfile=balanced` pointing at the unauthable `anthropic-managed`
 * connection. First message then fails with HTTP 422
 * `No API key configured for anthropic`.
 *
 * Anchoring under `$HOME/.vellum/run` keeps the file under the user's home
 * (always virtiofs-shared on Colima) on every platform.
 */
function hatchOverlayTmpDir(): string {
  const dir = join(homedir(), ".vellum", "run");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

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
    hatchOverlayTmpDir(),
    `vellum-default-workspace-config-${process.pid}-${Date.now()}.json`,
  );
  writeFileSync(tempPath, JSON.stringify(config, null, 2) + "\n");
  return tempPath;
}
