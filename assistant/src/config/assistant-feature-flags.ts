/**
 * Canonical assistant feature-flag resolver.
 *
 * Loads default flag values from the unified registry at
 * `meta/feature-flags/feature-flag-registry.json` and resolves the effective
 * enabled/disabled state for each declared assistant-scope flag by consulting
 * (in priority order):
 *   1. Override values from the gateway IPC socket
 *   2. defaults registry `defaultEnabled`         (for declared keys)
 *   3. `true`                                     (for undeclared keys)
 *
 * Key format:
 *   Canonical:  simple kebab-case string (e.g., "browser", "ces-tools")
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { ipcGetFeatureFlags } from "../ipc/gateway-client.js";
import { getLogger } from "../util/logger.js";
import type { AssistantConfig } from "./schema.js";

const log = getLogger("assistant-feature-flags");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FeatureFlagDefault {
  defaultEnabled: boolean;
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
 * filtering to assistant-scope flags only.
 */
function parseRegistryToDefaults(parsed: unknown): FeatureFlagDefaultsRegistry {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};

  const registry = parsed as { version?: number; flags?: unknown[] };
  if (!Array.isArray(registry.flags)) return {};

  const result: FeatureFlagDefaultsRegistry = {};
  for (const flag of registry.flags) {
    if (!flag || typeof flag !== "object" || Array.isArray(flag)) continue;
    const entry = flag as Record<string, unknown>;
    if (entry.scope !== "assistant") continue;
    if (typeof entry.key !== "string") continue;
    if (typeof entry.defaultEnabled !== "boolean") continue;

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
// Override loading — reads from gateway IPC socket or local file
// ---------------------------------------------------------------------------

/**
 * Module-level cache of feature flag override values. Populated lazily on
 * first access, invalidated by `clearFeatureFlagOverridesCache()`.
 */
let cachedOverrides: Record<string, boolean> | null = null;

/**
 * True when `cachedOverrides` was populated by the gateway IPC fetch (or
 * preseeded by a test). False/unset when the cache was populated by the sync
 * file fallback in `loadOverrides()`, which must not prevent a subsequent
 * authoritative gateway fetch from running.
 */
let cachedOverridesFromGateway = false;

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
): Promise<Record<string, boolean>> {
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
 * subsequent sync calls return an empty override map (registry defaults
 * only).
 *
 * Pass `retryBackoffsMs: []` to disable retries (used by unit tests that
 * intentionally simulate an unreachable gateway and want immediate
 * fallback without waiting through the production schedule).
 *
 * No-ops when the cache is already populated — callers that want to
 * refresh must call `clearFeatureFlagOverridesCache()` first. This lets
 * tests preseed flag state via `_setOverridesForTesting()` without the
 * gateway IPC call clobbering their setup.
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
  if (cachedOverridesFromGateway) return;

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
      // `_setOverridesForTesting`) may have populated the cache while we
      // were sleeping. Bail out so we don't clobber their setup.
      if (cachedOverridesFromGateway) return;
    }

    const gatewayOverrides = await fetchOverridesFromGateway(callTimeoutMs);
    if (Object.keys(gatewayOverrides).length > 0) {
      cachedOverrides = gatewayOverrides;
      cachedOverridesFromGateway = true;
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
  // registry default (`defaultEnabled`), which biases toward off for
  // newer assistant-scope flags.
  if (backoffs.length > 0) {
    log.warn(
      { attempts: backoffs.length + 1 },
      "Feature flag overrides empty after all retries; falling back to registry defaults",
    );
  }
}

/**
 * Read cached overrides synchronously.
 *
 * Returns the gateway-populated cache if `initFeatureFlagOverrides()` was
 * called at startup, or an empty record otherwise.
 */
function loadOverrides(): Record<string, boolean> {
  return cachedOverrides ?? {};
}

// ---------------------------------------------------------------------------
// Remote values — platform-pushed flags cached in a local JSON file
// ---------------------------------------------------------------------------

/**
 * Module-level cache of remote feature flag values. Populated lazily on
 * first access, invalidated by `clearFeatureFlagOverridesCache()`.
 */
let cachedRemoteValues: Record<string, boolean> | null = null;

/**
 * Load remote values with module-level caching.
 *
 * Remote values are now always included in the gateway IPC response (merged
 * server-side), so this only returns the injected test cache. In production,
 * remote values flow through the overrides cache.
 */
function loadRemoteValues(): Record<string, boolean> {
  return cachedRemoteValues ?? {};
}

/**
 * Invalidate the cached override and remote values so the next call to
 * `isAssistantFeatureFlagEnabled` re-reads from the source.
 *
 * Called by the config watcher when the feature-flags file changes.
 */
export function clearFeatureFlagOverridesCache(): void {
  cachedOverrides = null;
  cachedOverridesFromGateway = false;
  cachedRemoteValues = null;
}

/**
 * Directly inject override values into the module-level cache.
 *
 * **Test-only** — bypasses file/gateway loading so unit tests can control
 * flag state without writing to disk. Production code should never call this;
 * use `clearFeatureFlagOverridesCache()` instead and let the resolver
 * re-read from the appropriate source.
 *
 * Forces `cachedRemoteValues` to an empty record (not `null`) so the resolver
 * does not fall through to reading `feature-flags-remote.json` from disk. This
 * matters because a developer's local remote-cache file can leak platform-set
 * values into the test environment (e.g. `email-channel: true`), defeating
 * test isolation.
 */
export function _setOverridesForTesting(
  overrides: Record<string, boolean>,
): void {
  cachedOverrides = { ...overrides };
  cachedOverridesFromGateway = true;
  cachedRemoteValues = {};
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve whether an assistant feature flag is enabled.
 *
 * Resolution order:
 *   1. Override from gateway IPC socket
 *   2. defaults registry `defaultEnabled`         (for declared assistant-scope keys)
 *   3. `true`                                     (for undeclared keys with no override)
 */
export function isAssistantFeatureFlagEnabled(
  key: string,
  _config: AssistantConfig,
): boolean {
  const defaults = loadDefaultsRegistry();
  const declared = defaults[key];
  const overrides = loadOverrides();

  // 1. Check overrides from gateway / local file
  const explicit = overrides[key];
  if (typeof explicit === "boolean") return explicit;

  // 2. Check remote values (platform-pushed, cached locally)
  const remote = loadRemoteValues();
  const remoteValue = remote[key];
  if (typeof remoteValue === "boolean") return remoteValue;

  // 3. For declared keys, use the registry default
  if (declared) return declared.defaultEnabled;

  // 4. Undeclared keys with no persisted override default to enabled
  return true;
}
