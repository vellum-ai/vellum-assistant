/**
 * Canonical assistant feature-flag resolver.
 *
 * Loads default flag values from the unified registry at
 * `meta/feature-flags/feature-flag-registry.json` and resolves the effective
 * enabled/disabled state for each declared assistant-scope flag by consulting
 * (in priority order):
 *   1. Override values from the gateway IPC socket
 *   2. defaults registry `defaultEnabled`         (for declared keys)
 *   3. `false`                                    (for undeclared keys)
 *
 * Key format:
 *   Canonical:  simple kebab-case string (e.g., "browser", "ces-tools")
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { ipcGetFeatureFlags } from "../ipc/gateway-client.js";
import { getLogger } from "../util/logger.js";
import {
  clearCachedOverrides,
  getCachedOverrides,
  isCachedFromGateway,
  setCachedOverrides,
} from "./feature-flag-cache.js";
import type { AssistantConfig } from "./schema.js";

const log = getLogger("assistant-feature-flags");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FeatureFlagDefault {
  defaultEnabled: boolean | string;
  description: string;
  label: string;
}

export type FeatureFlagDefaultsRegistry = Record<string, FeatureFlagDefault>;

// ---------------------------------------------------------------------------
// Registry loading (singleton, loaded once)
// ---------------------------------------------------------------------------

let cachedDefaults: FeatureFlagDefaultsRegistry | undefined;

const REGISTRY_FILENAME = "feature-flag-registry.json";

function loadDefaultsRegistry(): FeatureFlagDefaultsRegistry {
  if (cachedDefaults) return cachedDefaults;

  const thisDir = import.meta.dirname ?? __dirname;
  const candidates = [
    // Bundled: co-located copy in the same directory as this source file.
    // Works in Docker / packaged builds where the repo-root `meta/` dir
    // is not available.
    join(thisDir, REGISTRY_FILENAME),
    // Packaged macOS app layout: the daemon binary lives at
    // <App>.app/Contents/MacOS/vellum-daemon and the registry is copied
    // to <App>.app/Contents/Resources/ by build.sh. In bun --compile
    // binaries, import.meta.dirname resolves to /$bunfs/root (virtual),
    // so we need to resolve relative to the real executable path.
    join(dirname(process.execPath), "..", "Resources", REGISTRY_FILENAME),
    // Development: relative to this source file's directory, walking up
    // to the repo root to reach `meta/feature-flags/`.
    join(thisDir, "..", "..", "..", "meta", "feature-flags", REGISTRY_FILENAME),
    // Alternate: from repo root via cwd
    join(process.cwd(), "meta", "feature-flags", REGISTRY_FILENAME),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      try {
        const raw = readFileSync(candidate, "utf-8");
        const parsed = JSON.parse(raw);
        cachedDefaults = parseRegistryToDefaults(parsed);
        return cachedDefaults;
      } catch {
        // Malformed file — fall through to next candidate
      }
    }
  }

  cachedDefaults = {};
  return cachedDefaults;
}

/**
 * Parse the unified registry JSON into a flat key -> default map,
 * filtering to flags the backend consumes (`assistant`- and `both`-scope).
 */
function parseRegistryToDefaults(parsed: unknown): FeatureFlagDefaultsRegistry {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};

  const registry = parsed as { version?: number; flags?: unknown[] };
  if (!Array.isArray(registry.flags)) return {};

  const result: FeatureFlagDefaultsRegistry = {};
  for (const flag of registry.flags) {
    if (!flag || typeof flag !== "object" || Array.isArray(flag)) continue;
    const entry = flag as Record<string, unknown>;
    if (entry.scope !== "assistant" && entry.scope !== "both") continue;
    if (typeof entry.key !== "string") continue;
    if (typeof entry.defaultEnabled !== "boolean" && typeof entry.defaultEnabled !== "string") continue;

    result[entry.key as string] = {
      defaultEnabled: entry.defaultEnabled,
      description:
        typeof entry.description === "string" ? entry.description : "",
      label: typeof entry.label === "string" ? entry.label : "",
    };
  }
  return result;
}

// ---------------------------------------------------------------------------
// Override loading — reads from gateway IPC socket
// ---------------------------------------------------------------------------
//
// The override cache lives in `feature-flag-cache.ts` (stdlib-only) so test
// helpers can seed it without dragging the pino logger + gateway IPC client
// transitively through their import chain. See that file's block comment.

/**
 * Fetch override values from the gateway via IPC (Unix domain socket).
 *
 * Returns the gateway's merged feature flag map (persisted > remote >
 * registry), or an empty record on any failure (socket not found,
 * timeout, parse error). No auth needed — the IPC socket is
 * access-controlled by file-system permissions on the shared volume.
 */
async function fetchOverridesFromGateway(
  timeoutMs?: number,
): Promise<Record<string, boolean | string>> {
  try {
    return await ipcGetFeatureFlags(timeoutMs);
  } catch {
    return {};
  }
}

/**
 * Default backoff schedule (ms) between `initFeatureFlagOverrides` retries
 * when the gateway IPC fetch returns empty. The daemon and gateway start
 * as sibling child processes of the macOS app, so the daemon can race
 * ahead of the gateway binding `gateway.sock`. Each delay is the
 * *additional* wait before the next attempt, so total worst-case latency
 * is the sum: 250 + 500 + 1000 + 2000 + 4000 = 7.75s. All retries run in
 * the background (lifecycle.ts fires `initFeatureFlagOverrides`
 * non-blocking), so this never delays startup.
 */
const DEFAULT_INIT_RETRY_BACKOFFS_MS: readonly number[] = [
  250, 500, 1000, 2000, 4000,
];

/**
 * Pre-populate the override cache from the gateway (async).
 *
 * Call this once during startup (daemon or CLI entry) before any sync
 * `isAssistantFeatureFlagEnabled` calls. In containerized mode, always
 * uses the gateway. In local mode, falls back to the local file when
 * the gateway is unreachable.
 *
 * Retries the gateway IPC fetch on empty/failed results — the gateway
 * may not have bound its IPC socket yet when the daemon races ahead at
 * startup. After exhausting retries, the cache is left unset so
 * subsequent sync calls return an empty override map (registry defaults for
 * declared flags, fail-closed for undeclared flags).
 *
 * Pass `retryBackoffsMs: []` to disable retries (used by unit tests that
 * intentionally simulate an unreachable gateway and want immediate
 * fallback without waiting through the production schedule).
 *
 * No-ops when the cache is already populated — callers that want to
 * refresh must call `clearFeatureFlagOverridesCache()` first. This lets
 * tests preseed flag state via `setOverridesForTesting()` (in
 * `__tests__/feature-flag-test-helpers.ts`) without the gateway IPC call
 * clobbering their setup.
 */
export async function initFeatureFlagOverrides(options?: {
  retryBackoffsMs?: readonly number[];
  /**
   * Timeout (ms) for each IPC call to the gateway. When omitted the
   * transport defaults apply (3 s connect + 5 s call). CLI callers should
   * pass a small value (e.g. 200) so a slow/absent gateway fails fast
   * instead of blocking startup.
   */
  callTimeoutMs?: number;
}): Promise<void> {
  if (isCachedFromGateway()) return;

  const backoffs = options?.retryBackoffsMs ?? DEFAULT_INIT_RETRY_BACKOFFS_MS;
  const callTimeoutMs = options?.callTimeoutMs;

  // First attempt has no preceding delay; subsequent attempts wait per the
  // backoff schedule. An empty result is treated as a transient miss
  // (gateway not yet bound) and triggers a retry — a healthy gateway
  // always returns at least the registry-merged flags.
  for (let attempt = 0; attempt <= backoffs.length; attempt++) {
    if (attempt > 0) {
      const delay = backoffs[attempt - 1]!;
      await new Promise((resolve) => setTimeout(resolve, delay));
      // Re-check after the wait: a concurrent caller (e.g. a test using
      // `setOverridesForTesting`) may have populated the cache while we
      // were sleeping. Bail out so we don't clobber their setup.
      if (isCachedFromGateway()) return;
    }

    const gatewayOverrides = await fetchOverridesFromGateway(callTimeoutMs);
    if (Object.keys(gatewayOverrides).length > 0) {
      setCachedOverrides(gatewayOverrides, { fromGateway: true });
      if (attempt > 0) {
        log.info(
          { attempt: attempt + 1 },
          "Feature flag overrides loaded from gateway after retry",
        );
      }
      return;
    }
  }

  // Exhausted retries — leave cache unset so loadOverrides() returns an
  // empty map on subsequent sync reads. Flag checks fall through to the
  // registry default (`defaultEnabled`) or the fail-closed undeclared default.
  if (backoffs.length > 0) {
    log.warn(
      { attempts: backoffs.length + 1 },
      "Feature flag overrides empty after all retries; falling back to registry defaults and fail-closed undeclared flags",
    );
  }
}

/**
 * Read cached overrides synchronously.
 *
 * Returns the gateway-populated cache if `initFeatureFlagOverrides()` was
 * called at startup, or an empty record otherwise.
 */
function loadOverrides(): Record<string, boolean | string> {
  return getCachedOverrides() ?? {};
}

/**
 * Invalidate the cached overrides so the next call to
 * `isAssistantFeatureFlagEnabled` re-reads from the gateway.
 *
 * Called by `refreshOverridesFromGateway()` when the gateway pushes a
 * `feature_flags_changed` event, and by tests between cases to reset
 * module state. (Tests typically call `setOverridesForTesting()` from
 * `__tests__/feature-flag-test-helpers.ts`, which combines clear + seed.)
 */
export function clearFeatureFlagOverridesCache(): void {
  clearCachedOverrides();
}

/**
 * Re-fetch feature flag overrides from the gateway.
 *
 * Clears the cached overrides and re-runs the gateway IPC fetch without
 * retries (the gateway is known to be up because it just pushed an event).
 * Called by the gateway flag listener when a `feature_flags_changed` event
 * arrives.
 */
export async function refreshOverridesFromGateway(): Promise<void> {
  clearFeatureFlagOverridesCache();
  await initFeatureFlagOverrides({ retryBackoffsMs: [] });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve the raw value for an assistant feature flag.
 *
 * Resolution order:
 *   1. Override from the gateway IPC fetch (includes platform-pushed remote
 *      values, which the gateway merges server-side: persisted > remote >
 *      registry)
 *   2. Registry `defaultEnabled` (for declared assistant-scope keys)
 *   3. `false` (for undeclared keys with no override)
 */
export function getAssistantFeatureFlagValue(
  key: string,
  _config: AssistantConfig,
): boolean | string {
  const defaults = loadDefaultsRegistry();
  const declared = defaults[key];
  const overrides = loadOverrides();

  const explicit = overrides[key];
  if (explicit !== undefined) return explicit;

  if (declared) return declared.defaultEnabled;

  return false;
}

/**
 * Resolve whether an assistant feature flag is enabled (boolean coercion).
 *
 * For boolean flags, returns the resolved value directly.
 * For string flags, returns true if the value is non-empty.
 * Undeclared keys return `false` (fail closed).
 */
export function isAssistantFeatureFlagEnabled(
  key: string,
  config: AssistantConfig,
): boolean {
  return !!getAssistantFeatureFlagValue(key, config);
}
