import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

import { safeStatSync } from "../util/fs.js";
import { getLogger } from "../util/logger.js";
import {
  ensureDataDir,
  getWorkspaceConfigPath,
  getWorkspaceDir,
} from "../util/platform.js";
import {
  isAssistantFeatureFlagEnabled,
  setOnFeatureFlagOverridesRefreshed,
} from "./assistant-feature-flags.js";
import {
  AUTO_PROFILE_KEY,
  isSeedDefaultBuiltinLabel,
  MANAGED_PROFILE_NAMES,
  resolveBuiltinProfiles,
} from "./builtin-inference-profiles.js";
import { AssistantConfigSchema } from "./schema.js";
import type { ProfileOverrideEntry } from "./schemas/llm.js";
import type { AssistantConfig } from "./types.js";

export { API_KEY_PROVIDERS } from "../providers/provider-secret-catalog.js";

const log = getLogger("config");

let cached: AssistantConfig | null = null;
let cachedFileSignature: ConfigFileSignature | null = null;
let loading = false;
let suppressConfigDiskWritesDepth = 0;

type ConfigFileSignature =
  | {
      path: string;
      exists: true;
      size: number;
      mtimeMs: number;
      ctimeMs: number;
    }
  | {
      path: string;
      exists: false;
    };

function getConfigPath(): string {
  return getWorkspaceConfigPath();
}

function ensureMigratedDataDir(): void {
  ensureDataDir();
}

function readConfigFileSignature(configPath: string): ConfigFileSignature {
  const stats = safeStatSync(configPath);
  if (!stats) {
    return {
      path: configPath,
      exists: false,
    };
  }

  return {
    path: configPath,
    exists: true,
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    ctimeMs: stats.ctimeMs,
  };
}

function configFileSignaturesEqual(
  a: ConfigFileSignature,
  b: ConfigFileSignature,
): boolean {
  if (a.path !== b.path || a.exists !== b.exists) return false;
  if (!a.exists || !b.exists) return true;
  return (
    a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs
  );
}

function getCachedConfigIfFresh(): AssistantConfig | null {
  if (!cached || !cachedFileSignature) return null;

  const currentSignature = readConfigFileSignature(getConfigPath());
  if (configFileSignaturesEqual(cachedFileSignature, currentSignature)) {
    return cached;
  }

  cached = null;
  cachedFileSignature = null;
  return null;
}

/**
 * Parse a raw config through the Zod schema, applying all nested defaults.
 *
 * All nested object schemas use `.default(SubSchema.parse({}))` which
 * pre-computes fully-resolved defaults at schema construction time, so a
 * single parse is sufficient to cascade defaults through every nesting level.
 */
export function applyNestedDefaults(config: unknown): AssistantConfig {
  return structuredClone(
    AssistantConfigSchema.parse(config),
  ) as AssistantConfig;
}

function cloneDefaultConfig(): AssistantConfig {
  return applyNestedDefaults({});
}

/**
 * True when running as a platform-managed (hosted) assistant deployment.
 * IS_PLATFORM is set by the Vellum platform launcher; local, Docker, and
 * bare-metal assistants are unaffected.
 */
export function isPlatformDeployment(): boolean {
  return process.env.IS_PLATFORM === "true" || process.env.IS_PLATFORM === "1";
}

/**
 * Returns deployment-context-aware config defaults that override schema
 * defaults for platform-managed assistants. Applied to every `loadConfig()`
 * call as a fill-only pass — they only fill keys that are absent from the
 * raw config on disk, so an explicit user choice (e.g. saving "your-own"
 * via the macOS Models & Services UI) always wins.
 */
export function getDeploymentContextDefaults(): Record<string, unknown> {
  if (!isPlatformDeployment()) {
    return {};
  }
  // `web-search.mode = managed` enables platform-backed app-executed search
  // for non-native inference providers while preserving provider-native hosted
  // search for providers/models that support it.
  const managed = { mode: "managed" as const };
  return {
    services: {
      "image-generation": managed,
      "web-search": managed,
      "google-oauth": managed,
      "outlook-oauth": managed,
      "linear-oauth": managed,
      "github-oauth": managed,
      "notion-oauth": managed,
      "asana-oauth": managed,
      "todoist-oauth": managed,
      "discord-oauth": managed,
      "hubspot-oauth": managed,
    },
  };
}

/**
 * Apply `contextDefaults` to `target` for any leaf keys that are absent from
 * `fileConfig` (the raw config-on-disk payload). Mutates `target` in place.
 *
 * "Absent" is checked at the leaf level by walking the `contextDefaults`
 * shape: nested objects recurse so a partial override on disk (e.g.
 * `{services: {inference: {model: "x"}}}` with no explicit `mode`) lets the
 * context default for `mode` win while leaving the user's `model` untouched.
 *
 * Pre-condition: `target` has already been passed through `validateWithSchema`
 * so every nested object in `contextDefaults` has a corresponding object in
 * `target`. The defensive whole-subtree assignment in the `!targetChild`
 * branch only fires for malformed inputs.
 */
export function fillContextDefaultsForMissingKeys(
  target: Record<string, unknown>,
  fileConfig: Record<string, unknown>,
  contextDefaults: Record<string, unknown>,
): void {
  for (const [key, value] of Object.entries(contextDefaults)) {
    const fileVal = fileConfig[key];
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      const targetChild = readPlainObject(target[key]);
      const fileChild = readPlainObject(fileVal);
      if (targetChild) {
        fillContextDefaultsForMissingKeys(
          targetChild,
          fileChild ?? {},
          value as Record<string, unknown>,
        );
      } else {
        target[key] = structuredClone(value);
      }
    } else if (fileVal === undefined) {
      target[key] = value;
    }
  }
}

/**
 * Build a filesystem-safe ISO-8601 timestamp for use in quarantine filenames.
 * Replaces `:` (invalid on Windows, confusing on macOS Finder) with `-` so the
 * resulting string is safe on every supported platform.
 */
function filesystemSafeTimestamp(date: Date = new Date()): string {
  return date.toISOString().replace(/:/g, "-");
}

/**
 * Rename a corrupt config file to a quarantine path so the bad content is
 * preserved for debug while the daemon falls through to defaults. Logs at
 * `error` level with a remediation hint. Best-effort: if the rename itself
 * fails (missing permissions, readonly FS, etc.) we still fall through to
 * defaults — startup must never block.
 *
 * The quarantine filename encodes a millisecond-precision timestamp and ends
 * in `.json` so editors syntax-highlight the preserved content:
 *   `<path>.corrupt-<ISO-timestamp>.json`
 *
 * On a successful rename, also appends a bulletin to `<workspace>/UPDATES.md`
 * so the background update-bulletin job surfaces the event to the user
 * proactively on their next interaction (log-level errors alone are invisible
 * to users).
 */
function quarantineCorruptConfig(configPath: string, err: unknown): string {
  const quarantinePath = `${configPath}.corrupt-${filesystemSafeTimestamp()}.json`;
  try {
    renameSync(configPath, quarantinePath);
    log.error(
      `config file at ${configPath} was corrupt (${String(err)}); ` +
        `quarantined to ${quarantinePath} and loaded defaults. ` +
        `Inspect the quarantined file to recover any hand-edited settings.`,
    );
    appendQuarantineBulletin(configPath, quarantinePath);
  } catch (renameErr) {
    log.error(
      { renameErr },
      `config file at ${configPath} was corrupt (${String(err)}) but could ` +
        `not be renamed for quarantine; loaded defaults.`,
    );
  }
  return quarantinePath;
}

/**
 * Append a config-quarantine bulletin to `<workspace>/UPDATES.md`. On the
 * next daemon boot the background update-bulletin job picks up UPDATES.md
 * and processes it inside a background-only conversation (not the user's
 * chat). The agent decides whether and when to surface the event — typical
 * cases are the user asking why their settings changed or noticing missing
 * API keys. The bulletin is agent-visible context, not a push notification.
 *
 * Idempotency: the appended block embeds a marker keyed on the quarantine
 * filename's basename. If that marker is already present in UPDATES.md (a
 * prior append succeeded but the process crashed before control returned, or
 * the file was hand-edited), the function is a no-op. This mirrors the
 * pattern release-notes workspace migrations use — see the "Release Update
 * Hygiene" section in the root `AGENTS.md`.
 *
 * Best-effort: any write failure is logged at `warn` and swallowed. The
 * quarantine path must never block startup, and the error log from
 * `quarantineCorruptConfig` remains the authoritative record.
 *
 * Exported with an underscore-prefixed alias (`_appendQuarantineBulletin`) so
 * tests can exercise the idempotent-skip branch directly with a deterministic
 * quarantine basename. Non-test callers should never import the underscore
 * alias — the wiring into `quarantineCorruptConfig` is the production entry
 * point.
 */
function appendQuarantineBulletin(
  originalPath: string,
  quarantinePath: string,
): void {
  try {
    const updatesPath = join(getWorkspaceDir(), "UPDATES.md");
    const quarantineBasename = basename(quarantinePath);
    const marker = `<!-- config-quarantine:${quarantineBasename} -->`;

    const existing = existsSync(updatesPath)
      ? readFileSync(updatesPath, "utf-8")
      : "";
    if (existing.includes(marker)) return;

    const timestamp = new Date().toISOString();
    const block =
      `## Config was reset to defaults\n\n` +
      `Your \`config.json\` was unreadable at ${timestamp} and couldn't be parsed ` +
      `as JSON. The assistant preserved the original file at \`${quarantinePath}\` ` +
      `and loaded defaults so the app stays working.\n\n` +
      `If you had custom settings (API keys, model choices, voice preferences), ` +
      `they are still in the quarantined file — \`cat ${quarantinePath}\` to ` +
      `recover them, then re-enter through Settings or the CLI.\n\n` +
      `${marker}\n`;

    const toWrite = existing.length === 0 ? block : `${existing}\n${block}`;
    writeFileSync(updatesPath, toWrite, "utf-8");
    log.info(
      `Appended config-quarantine bulletin to ${updatesPath} for ${originalPath} ` +
        `(quarantined as ${quarantineBasename}).`,
    );
  } catch (bulletinErr) {
    log.warn(
      { bulletinErr },
      `Failed to append config-quarantine bulletin to UPDATES.md; ` +
        `the quarantine event is still recorded in the assistant logs.`,
    );
  }
}

/**
 * Validate a raw config object with Zod. Invalid fields are logged as warnings
 * and replaced with defaults (matching prior behavior of per-field fallback).
 */
function validateWithSchema(raw: Record<string, unknown>): AssistantConfig {
  const result = AssistantConfigSchema.safeParse(raw);
  if (result.success) {
    return applyNestedDefaults(result.data);
  }

  // Log each validation issue as a warning
  for (const issue of result.error.issues) {
    const path = issue.path.join(".");
    log.warn(
      `Invalid config${path ? ` at "${path}"` : ""}: ${
        issue.message
      }. Falling back to default.`,
    );
  }

  // Strip invalid fields by setting them to undefined so Zod defaults apply,
  // then re-parse. We walk the error paths and delete the offending keys.
  const cleaned = structuredClone(raw);
  for (const issue of result.error.issues) {
    if (issue.path.length === 0) {
      // Top-level error — return full defaults
      return cloneDefaultConfig();
    }
    deleteNestedKey(cleaned, issue.path as (string | number)[]);
  }

  const retry = AssistantConfigSchema.safeParse(cleaned);
  if (retry.success) {
    return applyNestedDefaults(retry.data);
  }

  // If still failing, fall back to full defaults
  log.warn("Config validation failed after cleanup. Using full defaults.");
  return cloneDefaultConfig();
}

function deleteNestedKey(
  obj: Record<string, unknown>,
  path: (string | number)[],
): void {
  let current: unknown = obj;
  for (let i = 0; i < path.length - 1; i++) {
    if (current == null || typeof current !== "object") return;
    current = (current as Record<string, unknown>)[String(path[i])];
  }
  if (current != null && typeof current === "object") {
    delete (current as Record<string, unknown>)[String(path[path.length - 1])];
  }
}

/**
 * Merge the code-defined built-in inference profiles into a raw config
 * object. Mutates `raw` **in memory only** — the result must never be
 * persisted back to `config.json` (built-in definitions live in code; only
 * sparse `llm.profileOverrides` entries belong on disk).
 *
 * - Template fields (provider/model/maxTokens/…) are always authoritative;
 *   user-ownable facets are `label` and `status` only.
 * - `llm.profileOverrides[name]` is the canonical override store.
 * - **Transition-state compatibility**: pre-migration installs still carry
 *   full materialized built-in entries in `config.json` (including drifted
 *   shadow entries the assistant wrote on-platform). Such an entry's
 *   `label`/`status` are honored as *lower*-precedence overrides
 *   (key-presence semantics) and every other field is discarded. A stale
 *   label equal to a seed default (the bare template label or its BYOK
 *   `" (Managed)"` form) is a seeder artifact, not user intent, and is not
 *   lifted — the resolve-time default supplies the platform-appropriate
 *   label instead.
 * - Built-in names are spliced into `llm.profileOrder` exactly as the
 *   seeder does (auto prepended if missing, managed names appended if
 *   missing); flag-disabled built-ins are removed from the in-memory order
 *   and profile set entirely.
 * - `llm.activeProfile` falls back to `"balanced"` when unset or naming a
 *   profile absent from the merged set (matching the seeder's fallback).
 *   Custom user profiles count as present — an activeProfile naming one is
 *   left untouched.
 */
export function applyBuiltinProfiles(raw: Record<string, unknown>): void {
  const llm = ensurePlainObjectAt(raw, "llm");
  const profiles = ensurePlainObjectAt(llm, "profiles");
  const profileOverrides = readPlainObject(llm.profileOverrides) ?? {};

  const overrides: Record<string, ProfileOverrideEntry> = {};
  for (const name of MANAGED_PROFILE_NAMES) {
    const entry: ProfileOverrideEntry = {};
    // Lower precedence: label/status carried on a still-materialized entry.
    collectBuiltinOverrideFields(profiles[name], entry);
    // A stale label equal to a seed default is a seeder artifact, not user
    // intent — drop it so the resolve-time default supplies the
    // platform-appropriate label. Explicit `null` (cleared) and any other
    // string remain honored.
    if (
      typeof entry.label === "string" &&
      isSeedDefaultBuiltinLabel(name, entry.label)
    ) {
      delete entry.label;
    }
    // Higher precedence: the sparse override store.
    collectBuiltinOverrideFields(profileOverrides[name], entry);
    if ("label" in entry || "status" in entry) overrides[name] = entry;
  }

  const merged = resolveBuiltinProfiles({
    isPlatform: isPlatformDeployment(),
    isFlagEnabled: (key) => isBuiltinProfileFlagEnabled(key, raw),
    overrides,
  });

  // Replace materialized/stale entries with the code-resolved ones; built-ins
  // whose feature flag is disabled are removed from the profile set entirely.
  for (const name of MANAGED_PROFILE_NAMES) {
    const entry = merged.profiles[name];
    if (entry) {
      profiles[name] = entry;
    } else {
      delete profiles[name];
    }
  }

  // Profile ordering, mirroring the seeder: drop flag-disabled built-in
  // names, prepend `auto` if missing, then append the remaining built-ins
  // that aren't already present.
  const rawOrder = Array.isArray(llm.profileOrder) ? llm.profileOrder : [];
  const order = rawOrder.filter(
    (name) =>
      typeof name !== "string" ||
      !MANAGED_PROFILE_NAMES.has(name) ||
      merged.profiles[name] !== undefined,
  );
  const present = new Set(order);
  if (!present.has(AUTO_PROFILE_KEY)) order.unshift(AUTO_PROFILE_KEY);
  for (const name of merged.order) {
    if (name !== AUTO_PROFILE_KEY && !present.has(name)) order.push(name);
  }
  llm.profileOrder = order;

  // Active-profile fallback. Custom user profiles already live in
  // `profiles`, so an activeProfile naming one is left untouched.
  const active = llm.activeProfile;
  if (
    typeof active !== "string" ||
    readPlainObject(profiles[active]) === null
  ) {
    llm.activeProfile = "balanced";
  }
}

/**
 * Copy `label`/`status` from a raw (untrusted) profile or override entry
 * into `into`, by key presence, keeping only values of the legal override
 * shape (`string | null` label, `"active" | "disabled" | null` status).
 * Malformed values are ignored so a corrupt config can't smuggle arbitrary
 * data through the merge on the unvalidated `GET /v1/config` path.
 */
function collectBuiltinOverrideFields(
  value: unknown,
  into: ProfileOverrideEntry,
): void {
  const obj = readPlainObject(value);
  if (!obj) return;
  if ("label" in obj && (typeof obj.label === "string" || obj.label === null)) {
    into.label = obj.label;
  }
  if (
    "status" in obj &&
    (obj.status === "active" ||
      obj.status === "disabled" ||
      obj.status === null)
  ) {
    into.status = obj.status;
  }
}

/**
 * Resolve a built-in profile's gating feature flag. Wrapped in try/catch so
 * a flag-resolver failure never breaks config loading; fails *open* (profile
 * stays visible) because hiding built-ins on a transient resolver error
 * would be user-visible breakage, whereas the flag's purpose is an explicit
 * remote kill switch.
 *
 * The resolver ignores its config argument (it reads gateway overrides and
 * the bundled registry only); `raw` is passed for signature compatibility.
 */
function isBuiltinProfileFlagEnabled(
  key: string,
  raw: Record<string, unknown>,
): boolean {
  try {
    return isAssistantFeatureFlagEnabled(
      key,
      raw as unknown as AssistantConfig,
    );
  } catch {
    return true;
  }
}

/**
 * Read `parent[key]` as a plain object, creating (and assigning) an empty
 * one when the current value is absent or not a plain object.
 */
function ensurePlainObjectAt(
  parent: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const existing = readPlainObject(parent[key]);
  if (existing) return existing;
  const created: Record<string, unknown> = {};
  parent[key] = created;
  return created;
}

/**
 * Validate a raw config with the code-defined built-in profiles merged in.
 * The merge happens on a clone so `fileConfig` — which the loader's
 * disk-write paths (deprecated-field stripping, managed-Gemini migration,
 * first-launch seed) persist — never carries the injected entries.
 */
function validateWithBuiltinProfiles(
  fileConfig: Record<string, unknown>,
): AssistantConfig {
  const merged = structuredClone(fileConfig);
  applyBuiltinProfiles(merged);
  return validateWithSchema(merged);
}

/**
 * Deprecated config fields that have been removed. Each entry maps a
 * dot-separated path to the deprecation message shown to the user.
 */
const DEPRECATED_FIELDS: Record<string, string> = {
  "rateLimit.maxTokensPerSession":
    "rateLimit.maxTokensPerSession has been removed and is no longer enforced. " +
    "Per-session token budget tracking is no longer supported. " +
    "The field will be removed from your config file.",
  providerOrder:
    "providerOrder has been removed from the config schema. " +
    "Provider selection is now handled automatically. " +
    "The field will be removed from your config file.",
  "permissions.dangerouslySkipPermissions":
    "permissions.dangerouslySkipPermissions has been removed. " +
    "Permission prompts are now always shown when required. " +
    "The field will be removed from your config file.",
  "permissions.mode":
    "permissions.mode has been removed. The gateway now controls all auto-approve " +
    "thresholds. The field will be removed from your config file.",
  "permissions.autoApproveUpTo":
    "permissions.autoApproveUpTo has been removed. The gateway now controls all " +
    "auto-approve thresholds. The field will be removed from your config file.",
  "memory.jobs.batchSize":
    "memory.jobs.batchSize has been removed. The memory job worker now uses " +
    "per-lane concurrency caps (slowLlmConcurrency, fastConcurrency, " +
    "embedConcurrency) instead of a single batch size. " +
    "The field will be removed from your config file.",
};

/**
 * Check for deprecated config fields, log a warning for each one found,
 * and strip them from both the in-memory object and the on-disk config file
 * so the warning is only emitted once.
 */

function warnAndStripDeprecatedFields(
  fileConfig: Record<string, unknown>,
  configPath: string,
): void {
  const found: string[] = [];
  for (const dotPath of Object.keys(DEPRECATED_FIELDS)) {
    if (getNestedValue(fileConfig, dotPath) !== undefined) {
      log.warn(DEPRECATED_FIELDS[dotPath]);
      found.push(dotPath);
    }
  }

  if (found.length === 0) return;

  // Strip from the in-memory object so Zod never sees them
  for (const dotPath of found) {
    deleteNestedKeyByDotPath(fileConfig, dotPath);
  }

  // Persist the cleaned config to disk so the warning doesn't repeat
  try {
    if (existsSync(configPath)) {
      const raw = JSON.parse(readFileSync(configPath, "utf-8"));
      if (raw != null && typeof raw === "object" && !Array.isArray(raw)) {
        for (const dotPath of found) {
          deleteNestedKeyByDotPath(raw as Record<string, unknown>, dotPath);
        }
        writeFileSync(configPath, JSON.stringify(raw, null, 2) + "\n");
      }
    }
  } catch {
    // Best-effort — if the file can't be rewritten, the warning will repeat
    // on next load, which is acceptable.
  }
}

function deleteNestedKeyByDotPath(
  obj: Record<string, unknown>,
  dotPath: string,
): void {
  const keys = dotPath.split(".");
  deleteNestedKey(obj, keys);
}

/**
 * Recursively strip `null` leaves from a plain-object value, returning a
 * deep clone with all `null`-valued keys removed at every nesting level.
 * Non-object inputs (scalars, arrays, `null` itself) are returned as-is.
 *
 * Used to sanitize `overrides` before assigning whole subtrees in
 * `deepMergeOverwrite`, so deletion-sentinel semantics apply uniformly
 * even when the corresponding `target` key does not yet exist.
 */
function stripNullLeaves(value: unknown): unknown {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (v === null) continue;
    out[k] = stripNullLeaves(v);
  }
  return out;
}

function readPlainObject(value: unknown): Record<string, unknown> | null {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

/**
 * Deep-merge `overrides` into `target`, overwriting leaf values.
 * Recursively merges nested objects; scalars and arrays from `overrides`
 * replace corresponding values in `target`.
 *
 * JSON `null` semantics depend on what the target currently holds at
 * that key:
 *
 * - **Target holds a non-null object** (not array): `null` deletes the
 *   key, removing the entire subtree. This supports "clear entry"
 *   semantics (e.g. the macOS SettingsStore clearing a call-site
 *   override via `{ callSites: { memoryRetrieval: null } }`).
 *
 * - **Target holds a scalar, null, or array**: `null` is assigned as the
 *   value, preserving nullable config fields like `activeHoursStart`
 *   and `llmRequestLogRetentionMs` where `null` is a valid schema
 *   value meaning "disabled / no limit".
 *
 * - **Key absent from target**: no-op. Assigning null to a missing key
 *   would create a spurious entry; callers that want to establish a
 *   null value should set the key to its default first.
 *
 * When an override assigns a whole object subtree to a key that does
 * not yet exist on `target` (or whose existing value is a scalar/array),
 * `stripNullLeaves` drops any `null` leaves inside that subtree before
 * assignment so no invalid nulls get persisted for non-nullable fields.
 */
export function deepMergeOverwrite(
  target: Record<string, unknown>,
  overrides: Record<string, unknown>,
): void {
  for (const key of Object.keys(overrides)) {
    const ov = overrides[key];
    if (ov === null) {
      if (!(key in target)) continue;
      const existing = target[key];
      if (
        existing != null &&
        typeof existing === "object" &&
        !Array.isArray(existing)
      ) {
        delete target[key];
      } else {
        target[key] = null;
      }
    } else if (
      ov !== undefined &&
      typeof ov === "object" &&
      !Array.isArray(ov) &&
      target[key] != null &&
      typeof target[key] === "object" &&
      !Array.isArray(target[key])
    ) {
      deepMergeOverwrite(
        target[key] as Record<string, unknown>,
        ov as Record<string, unknown>,
      );
    } else {
      target[key] = stripNullLeaves(ov);
    }
  }
}

export type DefaultWorkspaceConfigMergeResult = {
  hadOverlay: boolean;
  providedLlmProfileNames: Set<string>;
  providedLlmActiveProfile: boolean;
  /**
   * Built-in profile names whose overlay entry carried provider-routing
   * fields (`provider`, `model`, `provider_connection`, `mix`) that the
   * conversion to `llm.profileOverrides` dropped. The overlay intended these
   * names to route somewhere other than the code-defined template, so the
   * seeder must not treat an `activeProfile` naming one of them as a genuine
   * selection of the managed built-in.
   */
  builtinProfilesWithDroppedProviderConfig: Set<string>;
};

/**
 * Provider-routing fields on an overlay profile entry. When one of these is
 * dropped from a built-in-name entry, the overlay's routing intent for that
 * profile is lost — tracked via `builtinProfilesWithDroppedProviderConfig`.
 */
const PROVIDER_ROUTING_PROFILE_KEYS = new Set([
  "provider",
  "model",
  "provider_connection",
  "mix",
]);

function emptyDefaultWorkspaceConfigMergeResult(): DefaultWorkspaceConfigMergeResult {
  return {
    hadOverlay: false,
    providedLlmProfileNames: new Set(),
    providedLlmActiveProfile: false,
    builtinProfilesWithDroppedProviderConfig: new Set(),
  };
}

/**
 * Merge default workspace config from the file referenced by
 * VELLUM_DEFAULT_WORKSPACE_CONFIG_PATH into the workspace config on disk.
 *
 * Called once at daemon startup (before the first loadConfig()) so platform
 * overrides are persisted to disk before the daemon's first config read.
 * Schema defaults are no longer materialized into the file on load — the
 * in-memory `loadConfig()` cache applies them at access time instead.
 */
export function mergeDefaultWorkspaceConfig(): DefaultWorkspaceConfigMergeResult {
  const defaultConfigPath = process.env.VELLUM_DEFAULT_WORKSPACE_CONFIG_PATH;
  if (!defaultConfigPath || !existsSync(defaultConfigPath)) {
    return emptyDefaultWorkspaceConfigMergeResult();
  }

  let defaults: unknown;
  try {
    defaults = JSON.parse(readFileSync(defaultConfigPath, "utf-8"));
  } catch (err) {
    log.warn(
      { err },
      "Failed to read default workspace config from %s",
      defaultConfigPath,
    );
    return emptyDefaultWorkspaceConfigMergeResult();
  }

  if (
    defaults == null ||
    typeof defaults !== "object" ||
    Array.isArray(defaults)
  ) {
    return emptyDefaultWorkspaceConfigMergeResult();
  }

  const llmDefaults = readPlainObject(
    (defaults as Record<string, unknown>).llm,
  );
  const providedProfiles = readPlainObject(llmDefaults?.profiles);

  // Overlay entries for built-in profile names are converted to sparse
  // `llm.profileOverrides` entries (label/status only) — built-in profile
  // config is code-defined and never materialized into `llm.profiles` on
  // disk. Non-override fields are dropped with a warning. The converted
  // names are excluded from `providedLlmProfileNames` so the seeder treats
  // only custom overlay names as overlay-owned.
  const convertedBuiltinNames = new Set<string>();
  const builtinProfilesWithDroppedProviderConfig = new Set<string>();
  if (llmDefaults && providedProfiles) {
    for (const name of Object.keys(providedProfiles)) {
      if (!MANAGED_PROFILE_NAMES.has(name)) continue;
      convertedBuiltinNames.add(name);
      const entry = readPlainObject(providedProfiles[name]);
      delete providedProfiles[name];
      if (!entry) continue;

      const override: ProfileOverrideEntry = {};
      collectBuiltinOverrideFields(entry, override);
      const droppedKeys = Object.keys(entry).filter(
        (key) => !(key in override),
      );
      if (droppedKeys.length > 0) {
        log.warn(
          { profile: name, droppedKeys },
          "Default workspace config supplied non-override fields for built-in profile %s; dropping them (built-in profile config is code-defined)",
          name,
        );
        if (droppedKeys.some((key) => PROVIDER_ROUTING_PROFILE_KEYS.has(key))) {
          builtinProfilesWithDroppedProviderConfig.add(name);
        }
      }
      if (Object.keys(override).length > 0) {
        const overridesStore = ensurePlainObjectAt(
          llmDefaults,
          "profileOverrides",
        );
        // An explicit `llm.profileOverrides.<name>` entry in the overlay is
        // the canonical representation and wins over fields lifted from the
        // legacy `llm.profiles.<name>` fragment; lifted fields only fill
        // keys the explicit override does not set.
        const existing = readPlainObject(overridesStore[name]);
        overridesStore[name] = { ...override, ...existing };
      }
    }
  }

  const mergeResult: DefaultWorkspaceConfigMergeResult = {
    hadOverlay: true,
    providedLlmProfileNames: new Set(
      providedProfiles ? Object.keys(providedProfiles) : [],
    ),
    providedLlmActiveProfile:
      llmDefaults != null &&
      Object.prototype.hasOwnProperty.call(llmDefaults, "activeProfile"),
    builtinProfilesWithDroppedProviderConfig,
  };

  const configPath = getConfigPath();
  let existing: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    try {
      existing = JSON.parse(readFileSync(configPath, "utf-8"));
    } catch (err) {
      quarantineCorruptConfig(configPath, err);
      // After preserving the corrupt file, start fresh so the default overlay
      // can still initialize a valid config for this startup.
    }
  }

  const overlayProfileNames = new Set([
    ...mergeResult.providedLlmProfileNames,
    ...convertedBuiltinNames,
  ]);
  if (overlayProfileNames.size > 0) {
    // Default-config profile entries are authoritative fragments. Remove any
    // old same-name profile first so recursive merge does not leave stale
    // provider-specific leaves behind. Converted built-in names are removed
    // too: the overlay owns the profile, and its entry now lives in
    // `llm.profileOverrides` rather than `llm.profiles`, so a stale
    // materialized entry must not survive as a shadow.
    const existingLlm = readPlainObject(existing.llm);
    const existingProfiles = readPlainObject(existingLlm?.profiles);
    if (existingProfiles) {
      for (const name of overlayProfileNames) {
        delete existingProfiles[name];
      }
    }
  }

  deepMergeOverwrite(existing, defaults as Record<string, unknown>);

  const dir = dirname(configPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(configPath, JSON.stringify(existing, null, 2) + "\n");
  invalidateConfigCache();

  // Move the temp file into the workspace directory as a permanent record.
  // This prevents re-application on daemon restart (the env var still points
  // at the old /tmp path which no longer exists).
  try {
    const dest = join(dir, "default-config.json");
    renameSync(defaultConfigPath, dest);
    log.info(
      "Merged default workspace config from %s (archived to %s)",
      defaultConfigPath,
      dest,
    );
  } catch {
    log.info("Merged default workspace config from %s", defaultConfigPath);
  }

  return mergeResult;
}

export function loadConfig(): AssistantConfig {
  const freshCached = getCachedConfigIfFresh();
  if (freshCached) return freshCached;

  // Re-entrancy guard: log calls during loading (e.g. file-mode warning)
  // can trigger loadConfig again. Return defaults to break the cycle
  // instead of recursing to stack overflow.
  if (loading) return cloneDefaultConfig();
  loading = true;

  try {
    ensureMigratedDataDir();
    const configPath = getConfigPath();

    let fileConfig: Record<string, unknown> = {};
    let configFileExisted = true;
    if (existsSync(configPath)) {
      try {
        const parsed: unknown = JSON.parse(readFileSync(configPath, "utf-8"));
        if (!isPlainObject(parsed)) {
          // Same shape contract as `loadRawConfig`: top-level value must be a
          // plain object. A `null`, primitive, or array is treated like a
          // parse error so downstream code (`warnAndStripDeprecatedFields`,
          // `setNestedValue` in the managed-Gemini migration block, etc.)
          // never iterates a non-record. Quarantine + fall through to defaults.
          quarantineCorruptConfig(
            configPath,
            new Error(
              `config.json must contain a JSON object at the top level; got ${describeJsonShape(parsed)}`,
            ),
          );
          fileConfig = {};
          configFileExisted = false;
        } else {
          fileConfig = parsed;
        }
      } catch (err) {
        // The daemon must never block startup (assistant/CLAUDE.md). A config
        // file that fails JSON.parse — truncated during a mid-write crash, or
        // hand-edited to invalid JSON — is quarantined so the content is
        // preserved for debug, and startup proceeds with the same default-
        // config path used when config.json does not exist.
        quarantineCorruptConfig(configPath, err);
        fileConfig = {};
        configFileExisted = false;
      }
    } else {
      configFileExisted = false;
    }

    if (suppressConfigDiskWritesDepth === 0) {
      warnAndStripDeprecatedFields(fileConfig, configPath);
    }

    // Validate and apply defaults via Zod schema, with the code-defined
    // built-in inference profiles merged in (on a clone — `fileConfig`
    // itself stays unmerged because the blocks below persist it to disk).
    // Merging before the parse lets the schema's cross-checks (activeProfile
    // and call-site profile references) see the full built-in entries.
    let config = validateWithBuiltinProfiles(fileConfig);

    if (suppressConfigDiskWritesDepth === 0) {
      // Managed Gemini embedding defaults migration.
      // When on a managed platform (IS_PLATFORM=true) with the feature flag
      // enabled and no explicit embedding provider chosen (provider=auto),
      // persist Gemini embedding defaults into the raw config file.
      // Idempotent: once provider=gemini is written, subsequent loads skip this.
      if (config.memory.embeddings.provider === "auto") {
        try {
          if (isPlatformDeployment() && isManagedGeminiFFEnabled(config)) {
            setNestedValue(fileConfig, "memory.embeddings.provider", "gemini");
            setNestedValue(
              fileConfig,
              "memory.embeddings.geminiModel",
              "gemini-embedding-2",
            );
            setNestedValue(
              fileConfig,
              "memory.embeddings.geminiDimensions",
              3072,
            );
            setNestedValue(fileConfig, "memory.qdrant.vectorSize", 3072);
            writeFileSync(
              configPath,
              JSON.stringify(fileConfig, null, 2) + "\n",
            );
            log.info(
              "Applied managed Gemini embedding defaults (provider=gemini, model=gemini-embedding-2, dimensions=3072, vectorSize=3072)",
            );
            // Re-validate so the returned config reflects the migration.
            config = validateWithBuiltinProfiles(fileConfig);
          }
        } catch (err) {
          log.warn(
            { err },
            "Managed Gemini defaults migration failed — continuing with existing config",
          );
        }
      }
    }

    // Layer deployment-context defaults (e.g. IS_PLATFORM=true → all service
    // modes = "managed") onto the in-memory config for any leaves that aren't
    // explicitly set in `fileConfig`. This runs on every load — not just the
    // first — because the workspace config file is written by upstream
    // lifecycle steps (`mergeDefaultWorkspaceConfig`, `seedInferenceProfiles`)
    // before `loadConfig()` is reached. Gating on `!configFileExisted` would
    // make the context defaults dead code on platform-managed daemons whose
    // config.json was created by those earlier steps without service-mode
    // entries. Explicit user choices on disk are preserved because the helper
    // only fills missing keys.
    const contextDefaults = getDeploymentContextDefaults();
    if (Object.keys(contextDefaults).length > 0) {
      fillContextDefaultsForMissingKeys(
        config as unknown as Record<string, unknown>,
        fileConfig,
        contextDefaults,
      );
    }

    // First-launch seed only: when config.json does not exist, write the full
    // schema defaults (with any deployment-context overrides already applied
    // above) to disk so users can discover and edit all available options.
    // When the file already exists, leave it alone — disk represents user
    // intent, while the in-memory `cached: AssistantConfig` (above) has all
    // schema defaults applied via `applyNestedDefaults`/`validateWithSchema`,
    // so consumers calling `getConfig().memory.v2.bm25_b` continue to receive
    // the schema default whenever the field is absent on disk.
    //
    // The previous behavior — eagerly merging missing keys back into the file
    // on every load — silently baked stale defaults into existing users'
    // config.json. Once a default landed in the file, future schema-default
    // changes were inert because the merge only filled absent keys and never
    // reconciled existing values. Contract: disk = user intent, in-memory
    // cache = effective values.
    if (!configFileExisted && suppressConfigDiskWritesDepth === 0) {
      try {
        const dir = dirname(configPath);
        if (!existsSync(dir)) {
          mkdirSync(dir, { recursive: true });
        }
        // Persist plain schema defaults (plus the deployment-context fills
        // applied above), validated WITHOUT the built-in profile merge — the
        // in-memory built-in entries are code-resolved on every load and
        // must never leak into config.json.
        const persistableConfig = validateWithSchema(fileConfig);
        if (Object.keys(contextDefaults).length > 0) {
          fillContextDefaultsForMissingKeys(
            persistableConfig as unknown as Record<string, unknown>,
            fileConfig,
            contextDefaults,
          );
        }
        // Strip dataDir (runtime-derived) from the persisted config
        const { dataDir: _, ...persistable } = persistableConfig;
        writeFileSync(configPath, JSON.stringify(persistable, null, 2) + "\n");
        log.info("Wrote default config to %s", configPath);
      } catch (err) {
        log.warn({ err }, "Failed to write default config file");
      }
    }

    cached = config;
    cachedFileSignature = readConfigFileSignature(configPath);

    loading = false;
    return config;
  } catch (err) {
    // Loading failed — clear cached so the next call retries
    cached = null;
    cachedFileSignature = null;
    loading = false;
    throw err;
  }
}

/**
 * Check whether the managed-gemini-embeddings-enabled feature flag is on.
 * Wrapped in a try/catch so a flag-resolver failure never breaks config loading.
 */
function isManagedGeminiFFEnabled(config: AssistantConfig): boolean {
  try {
    return isAssistantFeatureFlagEnabled(
      "managed-gemini-embeddings-enabled",
      config,
    );
  } catch {
    return false;
  }
}

export function getConfig(): AssistantConfig {
  return loadConfig();
}

/**
 * Read-only config accessor: returns the current config without creating
 * directories or writing files. Reads config.json if it exists on disk;
 * returns schema defaults otherwise — and also when the file is unparseable
 * or its top-level value is not a plain object (corrupt files are left in
 * place, never quarantined). Unlike `getConfig()` / `loadConfig()`,
 * this never calls `ensureDataDir()` or writes a default config to disk,
 * making it safe to call during CLI program construction before the
 * workspace-existence check runs.
 */
export function getConfigReadOnly(): AssistantConfig {
  const freshCached = getCachedConfigIfFresh();
  if (freshCached) return freshCached;

  const configPath = getConfigPath();
  let fileConfig: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(configPath, "utf-8"));
    } catch {
      return cloneDefaultConfig();
    }
    if (!isPlainObject(parsed)) {
      // Same top-level-shape contract as `loadConfig`: a `null`, primitive,
      // or array would TypeError inside `validateWithBuiltinProfiles`
      // (`ensurePlainObjectAt(raw, "llm")`). Fall back to defaults like the
      // parse-error path above — but never quarantine here: this accessor
      // must stay read-only and side-effect-free; `loadConfig` owns
      // quarantining on the next full load.
      log.warn(
        `config.json must contain a JSON object at the top level; got ${describeJsonShape(parsed)} — using defaults`,
      );
      return cloneDefaultConfig();
    }
    fileConfig = parsed;
  }

  return validateWithBuiltinProfiles(fileConfig);
}

export function invalidateConfigCache(): void {
  cached = null;
  cachedFileSignature = null;
  loading = false;
}

// The merged built-in profile set depends on feature-flag state, so a flag
// override refresh must recompute the parsed-config cache without a daemon
// restart. Registered as a callback (rather than the flags module importing
// `invalidateConfigCache`) because this module already imports
// `assistant-feature-flags.js` — a direct import back would form a cycle.
setOnFeatureFlagOverridesRefreshed(invalidateConfigCache);

export async function withSuppressedConfigDiskWrites<T>(
  fn: () => T | Promise<T>,
): Promise<T> {
  suppressConfigDiskWritesDepth++;
  try {
    return await fn();
  } finally {
    suppressConfigDiskWritesDepth--;
  }
}

export function withSuppressedConfigDiskWritesSync<T>(fn: () => T): T {
  suppressConfigDiskWritesDepth++;
  try {
    return fn();
  } finally {
    suppressConfigDiskWritesDepth--;
  }
}

/**
 * Load the raw config from disk without any secure-storage merging.
 * Used by CLI config commands to read/write the file directly.
 * API keys in secure storage are managed via `assistant keys` commands.
 *
 * Contract: returns a plain object (`Record<string, unknown>`). When
 * `config.json` is missing → returns `{}`. When the file is unparseable
 * (truncated, hand-edited to invalid JSON) OR when it parses to a value
 * that is technically valid JSON but NOT a plain object (`null`, a
 * primitive like `42`, `"hello"`, `true`, or an array `[…]`) → quarantines
 * the file and returns `{}`. Callers can therefore rely on the return
 * type without runtime shape-checking — the boundary check happens here.
 */
export function loadRawConfig(): Record<string, unknown> {
  ensureMigratedDataDir();
  const configPath = getConfigPath();
  if (!existsSync(configPath)) {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf-8"));
  } catch (err) {
    // Mirror loadConfig(): quarantine the corrupt file and return an empty
    // object rather than throwing. This prevents /v1/config from surfacing
    // a 500 when the user's config.json is malformed.
    quarantineCorruptConfig(configPath, err);
    return {};
  }

  if (!isPlainObject(parsed)) {
    // Valid JSON but the wrong shape — `null`, a primitive, or an array.
    // Treat the same as a parse error so the return-type contract above is
    // truthful and downstream callers (e.g. /v1/config handlers, twilio
    // integration routes, settings routes) can iterate keys safely.
    quarantineCorruptConfig(
      configPath,
      new Error(
        `config.json must contain a JSON object at the top level; got ${describeJsonShape(parsed)}`,
      ),
    );
    return {};
  }

  return parsed;
}

/**
 * Predicate for "the value is a plain JSON object" — i.e. not `null`, not
 * a primitive, and not an array. The cast on the truthy branch is safe
 * because the caller's static type narrowed accordingly.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Human-readable shape label for error messages. Distinguishes the four
 * non-object JSON shapes the loader rejects.
 */
function describeJsonShape(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return `a ${typeof value}`;
}

export function saveRawConfig(config: Record<string, unknown>): void {
  ensureMigratedDataDir();
  const configPath = getConfigPath();

  // Strip legacy apiKeys — provider keys belong in secure storage, not plaintext config
  delete config.apiKeys;

  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");

  cached = null; // invalidate cache
  cachedFileSignature = null;
}

export function getNestedValue(
  obj: Record<string, unknown>,
  path: string,
): unknown {
  const keys = path.split(".");
  let current: unknown = obj;
  for (const key of keys) {
    if (current == null || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

export function setNestedValue(
  obj: Record<string, unknown>,
  path: string,
  value: unknown,
): void {
  const keys = path.split(".");
  let current = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    if (current[key] == null || typeof current[key] !== "object") {
      current[key] = {};
    }
    current = current[key] as Record<string, unknown>;
  }
  current[keys[keys.length - 1]] = value;
}

/**
 * Test-only alias for `appendQuarantineBulletin`. Exists so the crash-mid-
 * append idempotency branch can be exercised with a deterministic quarantine
 * basename without widening the runtime surface. Not for production use.
 */
export const _appendQuarantineBulletin = appendQuarantineBulletin;
