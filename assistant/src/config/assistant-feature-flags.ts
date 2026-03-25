/**
 * Canonical assistant feature-flag resolver.
 *
 * Loads default flag values from the unified registry at
 * `meta/feature-flags/feature-flag-registry.json` and resolves the effective
 * enabled/disabled state for each declared assistant-scope flag by consulting
 * (in priority order):
 *   1. Override values from `~/.vellum/protected/feature-flags.json` (local)
 *      or via the gateway HTTP API (Docker/containerized)
 *   2. Remote values from `feature-flags-remote.json` (platform-pushed,
 *      cached locally; only used in local mode — containerized mode gets
 *      remote values via the gateway)
 *   3. defaults registry `defaultEnabled`         (for declared keys)
 *   4. `true`                                     (for undeclared keys)
 *
 * Key format:
 *   Canonical:  `feature_flags.<id>.enabled`
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { getRootDir } from "../util/platform.js";
import { getIsContainerized } from "./env-registry.js";
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
// Override loading — reads from protected directory or gateway HTTP
// ---------------------------------------------------------------------------

/**
 * Module-level cache of feature flag override values. Populated lazily on
 * first access, invalidated by `clearFeatureFlagOverridesCache()`.
 */
let cachedOverrides: Record<string, boolean> | null = null;

/**
 * File format for `~/.vellum/protected/feature-flags.json`, matching the
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
 * Local:  `~/.vellum/protected/feature-flags.json`
 */
function getFeatureFlagOverridesPath(): string {
  const securityDir = process.env.GATEWAY_SECURITY_DIR;
  if (securityDir) {
    return join(securityDir, "feature-flags.json");
  }
  return join(getRootDir(), "protected", "feature-flags.json");
}

/**
 * Load override values from the protected feature-flags.json file.
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
 * Load override values from the gateway via synchronous HTTP call.
 *
 * Follows the trust-client pattern: uses `Bun.spawnSync` + `curl` to make
 * a blocking GET request to the gateway's feature-flags endpoint. The
 * gateway returns `{ flags: Array<{ key, enabled, ... }> }` and we extract
 * just the key → enabled map.
 */
function loadOverridesFromGateway(): Record<string, boolean> {
  try {
    // Lazy-import to avoid circular dependency and keep this module
    // importable from bootstrap code when not in containerized mode.
    const { getGatewayInternalBaseUrl } =
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require("./env.js") as typeof import("./env.js");
    const { mintEdgeRelayToken } =
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require("../runtime/auth/token-service.js") as typeof import("../runtime/auth/token-service.js");

    const url = `${getGatewayInternalBaseUrl()}/v1/feature-flags`;
    const token = mintEdgeRelayToken();

    const proc = Bun.spawnSync(
      [
        "curl",
        "-s",
        "-S",
        "-X",
        "GET",
        "--max-time",
        "10",
        "-H",
        `Authorization: Bearer ${token}`,
        "-H",
        "Accept: application/json",
        "-w",
        "\n%{http_code}",
        url,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );

    if (proc.exitCode !== 0) return {};

    const output = proc.stdout.toString().trim();
    const lastNewline = output.lastIndexOf("\n");
    const responseBody = lastNewline >= 0 ? output.slice(0, lastNewline) : "";
    const statusCode = parseInt(
      lastNewline >= 0 ? output.slice(lastNewline + 1) : output,
      10,
    );

    if (statusCode < 200 || statusCode >= 300) return {};
    if (!responseBody) return {};

    const parsed = JSON.parse(responseBody) as {
      flags?: Array<{ key: string; enabled: boolean }>;
    };
    if (!Array.isArray(parsed.flags)) return {};

    const result: Record<string, boolean> = {};
    for (const entry of parsed.flags) {
      if (typeof entry.key === "string" && typeof entry.enabled === "boolean") {
        result[entry.key] = entry.enabled;
      }
    }
    return result;
  } catch {
    return {};
  }
}

/**
 * Load overrides from the appropriate source based on runtime mode.
 * Results are cached at module level.
 */
function loadOverrides(): Record<string, boolean> {
  if (cachedOverrides != null) return cachedOverrides;

  cachedOverrides = getIsContainerized()
    ? loadOverridesFromGateway()
    : loadOverridesFromFile();

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
 *   1. Override from `~/.vellum/protected/feature-flags.json` (local) or
 *      gateway HTTP (Docker/containerized)
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

  // 1. Check overrides from protected feature-flags file / gateway
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
