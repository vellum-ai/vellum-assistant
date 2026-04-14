import { SEEDS } from "./seeds.js";
import type { EnvironmentDefinition } from "./types.js";

const DEFAULT_ENVIRONMENT_NAME = "production";

/**
 * Look up a seed entry by name. Returns `undefined` if no seed matches.
 * Callers that need the full resolution stack (env-var overrides, default
 * fallback, error on unknown) should use {@link getCurrentEnvironment}
 * instead. The returned definition is a shallow copy so mutations by the
 * caller don't leak back into the seed table.
 */
export function getSeed(name: string): EnvironmentDefinition | undefined {
  const seed = SEEDS[name];
  if (!seed) return undefined;
  return { ...seed };
}

/**
 * Resolve the current environment definition.
 *
 * Priority:
 *   1. `override` argument (from a `--environment` CLI flag, when wired)
 *   2. `VELLUM_ENVIRONMENT` env var
 *   3. (future) user context file
 *   4. Default: `production`
 *
 * Per-field env-var overrides are honored on the resolved definition as
 * ad-hoc escape hatches (they do not materialize new environments):
 *   - `VELLUM_PLATFORM_URL` overrides `platformUrl`
 *   - `VELLUM_ASSISTANT_PLATFORM_URL` overrides `assistantPlatformUrl`
 *   - `VELLUM_LOCKFILE_DIR` overrides `lockfileDirOverride` (legacy e2e
 *     test hook used by `cli/src/lib/assistant-config.ts:getLockfileDir`)
 *   - `BASE_DATA_DIR` overrides `baseDataDirOverride` (legacy multi-instance
 *     hook — the CLI sets this when spawning per-instance daemons so the
 *     CLI and gateway resolve paths under `<instanceDir>/.vellum/`. The
 *     daemon itself does NOT honor this override; see
 *     `assistant/src/util/platform.ts:vellumRoot` which uses the seed-only
 *     resolver to preserve the post-#22085 invariant.)
 *
 * This function should be the single entrypoint for environment resolution.
 * No other code should drive off `VELLUM_ENVIRONMENT` directly.
 */
export function getCurrentEnvironment(
  override?: string,
): EnvironmentDefinition {
  const name = resolveEnvironmentName(override);
  const seed = SEEDS[name];
  if (!seed) {
    throw new Error(
      `unknown environment "${name}"; add it to packages/environments/src/seeds.ts and rebuild, or wait for the future file-based context layer`,
    );
  }

  const resolved: EnvironmentDefinition = { ...seed };

  const platformUrlOverride = process.env.VELLUM_PLATFORM_URL?.trim();
  if (platformUrlOverride) {
    resolved.platformUrl = platformUrlOverride;
  }

  const assistantPlatformUrlOverride =
    process.env.VELLUM_ASSISTANT_PLATFORM_URL?.trim();
  if (assistantPlatformUrlOverride) {
    resolved.assistantPlatformUrl = assistantPlatformUrlOverride;
  }

  const lockfileDirOverride = process.env.VELLUM_LOCKFILE_DIR?.trim();
  if (lockfileDirOverride) {
    resolved.lockfileDirOverride = lockfileDirOverride;
  }

  const baseDataDirOverride = process.env.BASE_DATA_DIR?.trim();
  if (baseDataDirOverride) {
    resolved.baseDataDirOverride = baseDataDirOverride;
  }

  return resolved;
}

function resolveEnvironmentName(override: string | undefined): string {
  const trimmedOverride = override?.trim();
  if (trimmedOverride && trimmedOverride.length > 0) {
    return trimmedOverride;
  }
  const envVar = process.env.VELLUM_ENVIRONMENT?.trim();
  if (envVar && envVar.length > 0) {
    return envVar;
  }

  return DEFAULT_ENVIRONMENT_NAME;
}
