/**
 * Canonical assistant feature-flag resolver.
 *
 * Loads default flag values from the unified registry at
 * `meta/feature-flags/feature-flag-registry.json` and resolves the effective
 * enabled/disabled state for each declared assistant-scope flag by consulting
 * (in priority order):
 *   1. Override values from the gateway HTTP API (or local file fallback)
 *   2. Remote values from `feature-flags-remote.json` (platform-pushed,
 *      cached locally; only used in local mode — containerized mode gets
 *      remote values via the gateway)
 *   3. defaults registry `defaultEnabled`         (for declared keys)
 *   4. `true`                                     (for undeclared keys)
 *
 * Key format:
 *   Canonical:  simple kebab-case string (e.g., "browser", "ces-tools")
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { AssistantConfig } from "./schema.js";

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
// Override loading — reads from gateway HTTP API or local file
// ---------------------------------------------------------------------------

/**
 * Module-level cache of feature flag override values. Populated lazily on
 * first access, invalidated by `clearFeatureFlagOverridesCache()`.
 */
let cachedOverrides: Record<string, boolean> | null = null;

/**
 * File format for the local feature-flags.json override file, matching the
 * gateway's feature-flag-store.ts schema.
 */
interface FeatureFlagFileData {
  version: 1;
  values: Record<string, boolean>;
}

/**
 * Resolve the path to the feature flag overrides file.
 *
 * Docker: `GATEWAY_SECURITY_DIR/feature-flags.json`
 * Local:  `~/.vellum/` + gateway security subdir + `feature-flags.json`
 */
function getFeatureFlagOverridesPath(): string {
  const securityDir = process.env.GATEWAY_SECURITY_DIR;
  if (securityDir) {
    return join(securityDir, "feature-flags.json");
  }
  return join(homedir(), ".vellum", "protected", "feature-flags.json");
}

/**
 * Load override values from the local feature-flags.json file.
 * Returns an empty record if the file doesn't exist or is malformed.
 */
function loadOverridesFromFile(): Record<string, boolean> {
  const path = getFeatureFlagOverridesPath();
  if (!existsSync(path)) return {};

  try {
    const raw = readFileSync(path, "utf-8");
    const data = JSON.parse(raw) as FeatureFlagFileData;
    if (data.version !== 1) return {};
    if (
      data.values &&
      typeof data.values === "object" &&
      !Array.isArray(data.values)
    ) {
      const filtered: Record<string, boolean> = {};
      for (const [k, v] of Object.entries(data.values)) {
        if (typeof v === "boolean") filtered[k] = v;
      }
      return filtered;
    }
    return {};
  } catch {
    return {};
  }
}

/**
 * Fetch override values from the gateway via IPC.
 *
 * Connects to the gateway's Unix domain socket and calls `getFeatureFlags`
 * to retrieve the merged flag state (persisted > remote > registry).
 * Returns an empty record on any failure (socket not available, timeout).
 */
async function fetchOverridesFromGateway(): Promise<Record<string, boolean>> {
  try {
    const { getGatewayIpcClient } = await import("../ipc/gateway-client.js");
    const client = getGatewayIpcClient();

    // Wait briefly for the client to connect if it hasn't yet.
    // The gateway may still be starting up.
    if (!client.isConnected()) {
      await new Promise<void>((resolve) => {
        const onConnect = () => {
          cleanup();
          resolve();
        };
        const timer = setTimeout(() => {
          cleanup();
          resolve();
        }, 5_000);
        const cleanup = () => {
          client.removeListener("connected", onConnect);
          clearTimeout(timer);
        };
        client.once("connected", onConnect);
      });
    }

    if (!client.isConnected()) return {};

    return await client.getFeatureFlags();
  } catch {
    return {};
  }
}

/**
 * Pre-populate the override cache from the gateway (async).
 *
 * Call this once during startup (daemon or CLI entry) before any sync
 * `isAssistantFeatureFlagEnabled` calls. Fetches the merged flag state
 * from the gateway via IPC. Falls back to the local file when the
 * gateway is unreachable.
 *
 * Also subscribes to `feature_flags_changed` events so the cache is
 * automatically refreshed when the gateway detects flag file changes.
 *
 * On failure, the cache is left unset so subsequent sync calls fall
 * through to the file-based fallback rather than caching an empty map
 * that masks all overrides for the process lifetime.
 */
export async function initFeatureFlagOverrides(): Promise<void> {
  const gatewayOverrides = await fetchOverridesFromGateway();
  if (Object.keys(gatewayOverrides).length > 0) {
    cachedOverrides = gatewayOverrides;
  }

  // Subscribe to feature flag change events from the gateway so the
  // cache stays fresh without polling.
  try {
    const { getGatewayIpcClient } = await import("../ipc/gateway-client.js");
    const client = getGatewayIpcClient();
    client.on("feature_flags_changed", (data: unknown) => {
      if (data && typeof data === "object" && !Array.isArray(data)) {
        cachedOverrides = data as Record<string, boolean>;
      } else {
        // Event without payload — invalidate cache so next read re-fetches
        cachedOverrides = null;
      }
    });
  } catch {
    // IPC not available — continue without live updates
  }
}

/**
 * Read cached overrides synchronously.
 *
 * If `initFeatureFlagOverrides()` was called at startup, this returns the
 * pre-populated cache. Otherwise falls back to the local file — this
 * ensures the resolver never blocks on a network call.
 */
function loadOverrides(): Record<string, boolean> {
  if (cachedOverrides != null) return cachedOverrides;

  // Cache not yet populated (initFeatureFlagOverrides wasn't called or
  // hasn't finished). Fall back to the local file so the resolver still
  // works, just without gateway data.
  cachedOverrides = loadOverridesFromFile();
  return cachedOverrides;
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
 * Load remote flag values from the `feature-flags-remote.json` file that
 * lives alongside the local overrides file. Returns an empty record if the
 * file doesn't exist or is malformed.
 *
 * In containerized mode, this file won't exist — the gateway already merges
 * remote values into its response — so we'll harmlessly return `{}`.
 */
function loadRemoteValuesFromFile(): Record<string, boolean> {
  const overridesPath = getFeatureFlagOverridesPath();
  const remotePath = join(dirname(overridesPath), "feature-flags-remote.json");
  if (!existsSync(remotePath)) return {};

  try {
    const raw = readFileSync(remotePath, "utf-8");
    const data = JSON.parse(raw) as FeatureFlagFileData;
    if (data.version !== 1) return {};
    if (
      data.values &&
      typeof data.values === "object" &&
      !Array.isArray(data.values)
    ) {
      const filtered: Record<string, boolean> = {};
      for (const [k, v] of Object.entries(data.values)) {
        if (typeof v === "boolean") filtered[k] = v;
      }
      return filtered;
    }
    return {};
  } catch {
    return {};
  }
}

/**
 * Load remote values with module-level caching.
 */
function loadRemoteValues(): Record<string, boolean> {
  if (cachedRemoteValues != null) return cachedRemoteValues;
  cachedRemoteValues = loadRemoteValuesFromFile();
  return cachedRemoteValues;
}

/**
 * Invalidate the cached override and remote values so the next call to
 * `isAssistantFeatureFlagEnabled` re-reads from the source.
 *
 * Called by the config watcher when the feature-flags file changes.
 */
export function clearFeatureFlagOverridesCache(): void {
  cachedOverrides = null;
  cachedRemoteValues = null;
}

/**
 * Directly inject override values into the module-level cache.
 *
 * **Test-only** — bypasses file/gateway loading so unit tests can control
 * flag state without writing to disk. Production code should never call this;
 * use `clearFeatureFlagOverridesCache()` instead and let the resolver
 * re-read from the appropriate source.
 */
export function _setOverridesForTesting(
  overrides: Record<string, boolean>,
): void {
  cachedOverrides = { ...overrides };
  cachedRemoteValues = null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve whether an assistant feature flag is enabled.
 *
 * Resolution order:
 *   1. Override from gateway HTTP API (or local file fallback)
 *   2. Remote value from `feature-flags-remote.json` (platform-pushed,
 *      cached locally)
 *   3. defaults registry `defaultEnabled`         (for declared assistant-scope keys)
 *   4. `true`                                     (for undeclared keys with no override)
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

/**
 * Return the loaded defaults registry (for introspection/tooling).
 */
export function getAssistantFeatureFlagDefaults(): FeatureFlagDefaultsRegistry {
  return loadDefaultsRegistry();
}
