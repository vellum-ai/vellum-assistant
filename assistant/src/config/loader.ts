import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { safeStatSync } from "../util/fs.js";
import { getLogger } from "../util/logger.js";
import {
  ensureDataDir,
  getConfigQuarantineNoticePath,
  getConfigValidationResetNoticePath,
  getWorkspaceConfigPath,
} from "../util/platform.js";
import { pruneSeededCallsiteDefaultsFromConfig } from "./prune-seeded-callsite-defaults.js";
import { AssistantConfigSchema } from "./schema.js";
import type { AssistantConfig } from "./types.js";

const log = getLogger("config");

let cached: AssistantConfig | null = null;
let cachedFileSignature: ConfigFileSignature | null = null;
let loading = false;
let suppressConfigDiskWritesDepth = 0;

/**
 * The most recent effective config in this process. Captured inside
 * {@link validateWithSchema} on every validation-success path, then overwritten
 * by {@link loadConfig} with the deployment-context-filled config whenever
 * context defaults apply — so it reflects the config as consumers actually see
 * it (managed service modes and all), not just the pre-fill schema-defaulted
 * view. It is a safety net for the recovery ladder — when config.json later
 * fails validation even after per-key cleanup, the last-known-good config is
 * preferred over discarding the user's entire configuration and falling back to
 * schema defaults.
 *
 * Deliberately NOT cleared by {@link invalidateConfigCache}: cache
 * invalidation forces a re-read from disk, but the safety net must survive a
 * re-read so it can rescue a subsequently-corrupted config.
 */
let lastKnownGoodConfig: AssistantConfig | null = null;

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
 * Returns deployment-context-aware config defaults that override schema
 * defaults for platform-managed assistants. Applied to every `loadConfig()`
 * call as a fill-only pass — they only fill keys that are absent from the
 * raw config on disk, so an explicit user choice (e.g. saving "your-own"
 * via the macOS Models & Services UI) always wins.
 *
 * IS_PLATFORM is set by the Vellum platform launcher for all hosted
 * assistant deployments. Local, Docker, and bare-metal assistants are
 * unaffected.
 */
export function getDeploymentContextDefaults(): Record<string, unknown> {
  if (process.env.IS_PLATFORM !== "true" && process.env.IS_PLATFORM !== "1") {
    return {};
  }
  // `web-search.mode = managed` enables platform-backed app-executed search
  // for non-native inference providers while preserving provider-native hosted
  // search for providers/models that support it.
  const managed = { mode: "managed" as const };
  return {
    // Express platform intent that hosted assistants embed via the managed
    // Gemini backend. Fill-only (applied in-memory by
    // `fillContextDefaultsForMissingKeys`), so it expresses the default without
    // persisting it or overriding an explicit on-disk provider. The committed
    // dimension (`memory.qdrant.vectorSize`) and `geminiModel` are NOT set here:
    // the dimension is derived at startup by the embedding-identity reconcile
    // from a live backend probe, and `geminiModel` carries its own schema
    // default (`gemini-embedding-2`).
    memory: { embeddings: { provider: "gemini" } },
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
 * On a successful rename, also writes a small JSON sentinel recording the
 * event so the per-turn `config-quarantine-notice` injector can surface it to
 * the agent (log-level errors alone are invisible to users).
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
    writeQuarantineNotice(configPath, quarantinePath);
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
 * Write a small JSON sentinel recording that the config file was quarantined.
 * The per-turn `config-quarantine-notice` injector reads this sentinel and, if
 * it is recent, injects a system block so the agent can explain the reset when
 * the user asks why their settings changed or notices missing API keys.
 *
 * Writes with pure `node:fs` and a workspace-derived path
 * ({@link getConfigQuarantineNoticePath}) deliberately: config load happens
 * extremely early at daemon startup — before the SQLite DB is initialized and
 * before `getConfig().dataDir` is available — so neither a DB checkpoint nor a
 * config-dependent path can be used here without risking import-time DB init.
 *
 * Idempotent per quarantine event: each call overwrites the sentinel with the
 * latest event, so a crash-then-retry re-records the same (or newer) event
 * rather than accumulating duplicates.
 *
 * Best-effort: any write failure is logged at `warn` and swallowed. The
 * quarantine path must never block startup, and the error log from
 * `quarantineCorruptConfig` remains the authoritative record.
 *
 * Exported with an underscore-prefixed alias (`_writeQuarantineNotice`) so
 * tests can exercise the write directly. Non-test callers should never import
 * the underscore alias — the wiring into `quarantineCorruptConfig` is the
 * production entry point.
 */
function writeQuarantineNotice(
  originalPath: string,
  quarantinePath: string,
): void {
  try {
    const noticePath = getConfigQuarantineNoticePath();
    const dir = dirname(noticePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const notice = {
      quarantinedAt: new Date().toISOString(),
      quarantinePath,
      originalPath,
    };
    writeFileSync(noticePath, JSON.stringify(notice, null, 2) + "\n", "utf-8");
    log.info(
      `Wrote config-quarantine notice to ${noticePath} for ${originalPath} ` +
        `(quarantined as ${quarantinePath}).`,
    );
  } catch (noticeErr) {
    log.warn(
      { noticeErr },
      `Failed to write config-quarantine notice; the quarantine event is ` +
        `still recorded in the assistant logs.`,
    );
  }
}

/** Minimal structural view of the Zod issues the recovery ladder consumes. */
type ValidationIssue = { path: PropertyKey[]; message: string };

/** Join a Zod issue's path/message into a single human-readable clause. */
function describeIssues(issues: ValidationIssue[]): string {
  return issues
    .map((issue) => {
      const path = issue.path.join(".");
      return path ? `"${path}": ${issue.message}` : issue.message;
    })
    .join("; ");
}

/**
 * Record a "config.json did not take effect as written" event so the per-turn
 * `config-validation-reset-notice` injector can surface it to the agent. Unlike
 * {@link writeQuarantineNotice} (JSON-corrupt file, quarantined), this fires
 * when `config.json` parses as valid JSON but fails schema validation hard
 * enough that per-key cleanup cannot repair it and {@link validateWithSchema}
 * hands off to {@link recoverFromInvalidConfig} — e.g. an unknown key that masks
 * a `superRefine` violation until the strip unmasks it. Every rung of that
 * ladder leaves at least part of the user's saved configuration inactive, and
 * the rungs that reset a section (or the whole config) to schema defaults
 * silently revert settings the user never touched: managed service modes, model
 * choices, API keys. The on-disk file is left intact, so the user's values are
 * still present but inactive until the invalid entries are fixed.
 *
 * Deliberately NOT gated on `suppressConfigDiskWritesDepth`. The only suppressed
 * `getConfig()` is the re-parse inside `commitConfigWrite`, which runs *after*
 * `saveRawConfig` — so it reflects the persisted config, not a transient one. A
 * bad conversational `config set` must surface the degradation it just caused;
 * skipping the write here would leave that live-session event silent, because
 * the recovered config is then cached against the invalid file signature and
 * later loads short-circuit before re-validating. The sentinel is a separate
 * file, so writing it does not conflict with the suppression's purpose
 * (blocking the first-launch-seed / deprecated-strip rewrites of config.json).
 *
 * Best-effort — any failure is logged and swallowed; the `log.error` recovery
 * lines remain the authoritative record. `invalidPaths` is capped so a
 * pathological config cannot bloat the sentinel.
 */
function recordConfigValidationReset(invalidPaths: string[]): void {
  try {
    const noticePath = getConfigValidationResetNoticePath();
    const dir = dirname(noticePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const dedupedPaths = [...new Set(invalidPaths.filter(Boolean))].slice(
      0,
      50,
    );
    const notice = {
      resetAt: new Date().toISOString(),
      invalidPaths: dedupedPaths,
    };
    writeFileSync(noticePath, JSON.stringify(notice, null, 2) + "\n", "utf-8");
    log.warn(
      `Wrote config-validation-reset notice to ${noticePath}; config.json ` +
        `failed schema validation and did not fully take effect (${
          dedupedPaths.length
        } invalid path(s): ${dedupedPaths.join(", ") || "top-level"}).`,
    );
  } catch (noticeErr) {
    log.warn(
      { noticeErr },
      `Failed to write config-validation-reset notice; the event is still ` +
        `recorded in the assistant logs.`,
    );
  }
}

/**
 * Clear any stale config-validation-reset sentinel once the config validates
 * cleanly again — the event is recoverable (fix the invalid entry and the values
 * come back), so the notice must stop as soon as the config parses, not linger
 * until age-out like a quarantine. Not gated on suppression (see {@link
 * recordConfigValidationReset}): the suppressed re-parse inside
 * `commitConfigWrite` is exactly when a user fixes their config via `config
 * set`, and the config it produced is about to be cached against the new
 * signature — so if we skipped clearing here, later short-circuiting loads
 * would keep injecting the stale notice until age-out. Best-effort.
 */
function clearConfigValidationResetNotice(): void {
  try {
    rmSync(getConfigValidationResetNoticePath(), { force: true });
  } catch {
    // Best-effort — a failed delete just means the injector re-checks (and the
    // sentinel ages out) next turn.
  }
}

/**
 * Validate a raw config object with Zod, applying schema defaults for absent
 * keys. Invalid fields are logged and stripped so their schema defaults apply,
 * then the config is re-parsed.
 *
 * When cleanup fails to produce a valid config, recovery follows a ladder
 * (see {@link recoverFromInvalidConfig}) that prefers preserving as much of the
 * user's configuration as possible over discarding it wholesale:
 *   1. the last-known-good config validated earlier in this process,
 *   2. a per-section salvage that keeps every top-level section that validates
 *      on its own and defaults only the ones that do not, and
 *   3. full schema defaults as the true last resort.
 *
 * Every success path records a `structuredClone` of the returned config as the
 * last-known-good safety net. Cloning is required because `loadConfig` mutates
 * the returned object in place via `fillContextDefaultsForMissingKeys`.
 */
function validateWithSchema(raw: Record<string, unknown>): AssistantConfig {
  const result = AssistantConfigSchema.safeParse(raw);
  if (result.success) {
    clearConfigValidationResetNotice();
    const config = applyNestedDefaults(result.data);
    lastKnownGoodConfig = structuredClone(config);
    return config;
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
  // then re-parse. We walk the error paths and delete the offending keys,
  // pruning any ancestor object the deletion leaves empty. Pruning matters for
  // nested overrides like `llm.callSites.<id>.profile`: stripping just the
  // invalid `.profile` leaf would leave `llm.callSites.<id> = {}`, which the
  // resolver treats as a present (non-default) override and so skips the
  // shipped call-site default — silently downgrading the call site to the
  // active profile. Removing the emptied object lets that default apply.
  const cleaned = structuredClone(raw);
  for (const issue of result.error.issues) {
    if (issue.path.length === 0) {
      // Top-level error — individual keys cannot be stripped. Recover working
      // from the clone as-is (its top-level sections are still iterable).
      return recoverFromInvalidConfig(
        cleaned,
        [...result.error.issues],
        issuePaths(result.error.issues),
      );
    }
    deleteNestedKey(cleaned, issue.path as (string | number)[], true);
  }

  const retry = AssistantConfigSchema.safeParse(cleaned);
  if (retry.success) {
    clearConfigValidationResetNotice();
    const config = applyNestedDefaults(retry.data);
    lastKnownGoodConfig = structuredClone(config);
    return config;
  }

  // Record BOTH the first-parse paths (what was stripped) and the retry paths
  // (what still failed) so the notice can name what went wrong — a first-parse
  // `invalid_key` can abort the record parse and mask a latent `superRefine`
  // that only the retry surfaces, and vice versa.
  return recoverFromInvalidConfig(
    cleaned,
    [...retry.error.issues],
    [...issuePaths(result.error.issues), ...issuePaths(retry.error.issues)],
  );
}

/** Dotted paths for a set of Zod issues; a top-level issue yields `""`. */
function issuePaths(issues: readonly ValidationIssue[]): string[] {
  return issues.map((issue) => issue.path.join("."));
}

/**
 * Recover a usable config when {@link validateWithSchema}'s strip-and-reparse
 * cleanup cannot produce a valid config, minimizing how much of the user's
 * configuration is discarded.
 *
 * Ladder:
 *   1. If a last-known-good config was captured earlier in this process, keep
 *      it — config.json on disk is untouched, so only the in-memory view is
 *      degraded and the previous good values are the closest safe substitute.
 *   2. Otherwise (first load after startup), salvage section-by-section: keep
 *      every top-level section of `cleaned` that validates on its own and reset
 *      only the sections that do not. This rung requires `cleaned` to be a plain
 *      object; a top-level non-object config (JSON `null`, a primitive, or an
 *      array) has no sections to iterate and is skipped straight to rung 3.
 *   3. If even the combined kept sections fail to parse, return full schema
 *      defaults.
 *
 * Every rung leaves some part of the user's saved config inactive, so all of
 * them record the validation-reset sentinel (see {@link
 * recordConfigValidationReset}) — the agent needs to explain a setting that
 * reverted (rungs 2 and 3) or a `config set` that never took effect (rung 1).
 *
 * `issues` are the ones still unresolved after cleanup, used for the operator
 * log; `invalidPaths` spans every parse attempt and is what the sentinel
 * records.
 */
function recoverFromInvalidConfig(
  cleaned: unknown,
  issues: ValidationIssue[],
  invalidPaths: string[],
): AssistantConfig {
  recordConfigValidationReset(invalidPaths);
  const issueSummary = describeIssues(issues);

  if (lastKnownGoodConfig) {
    log.error(
      `config.json failed validation even after stripping invalid fields; ` +
        `keeping the last-known-good configuration from this process. Fix ` +
        `config.json to apply your changes (validation issues: ${issueSummary}).`,
    );
    return structuredClone(lastKnownGoodConfig);
  }

  if (!isPlainObject(cleaned)) {
    // The per-section salvage below walks `Object.entries(cleaned)`, which
    // throws on `null` and yields no config sections for a primitive or array.
    // A top-level non-object config carries no recoverable sections, so load
    // full schema defaults.
    log.error(
      `config.json is not a JSON object at the top level; loading full ` +
        `defaults. Fix config.json to restore your settings (validation ` +
        `issues: ${issueSummary}).`,
    );
    return cloneDefaultConfig();
  }

  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(cleaned)) {
    const sectionResult = AssistantConfigSchema.safeParse({ [key]: value });
    if (sectionResult.success) {
      kept[key] = value;
    } else {
      log.error(
        `config.json section "${key}" failed validation; resetting it to ` +
          `defaults.`,
      );
    }
  }

  const salvaged = AssistantConfigSchema.safeParse(kept);
  if (salvaged.success) {
    const config = applyNestedDefaults(salvaged.data);
    lastKnownGoodConfig = structuredClone(config);
    return config;
  }

  log.error(
    `config.json could not be salvaged section-by-section; loading full ` +
      `defaults. Fix config.json to restore your settings (validation ` +
      `issues: ${describeIssues([...salvaged.error.issues])}).`,
  );
  return cloneDefaultConfig();
}

/**
 * Delete the key at `path` from `obj`. When `pruneEmptyAncestors` is set, also
 * remove any ancestor object the deletion leaves empty, walking up until the
 * first ancestor that still holds other keys. Only empty plain objects are
 * pruned (arrays are left alone), and a still-populated ancestor stops the walk
 * so a container holding other config is never removed.
 */
function deleteNestedKey(
  obj: Record<string, unknown>,
  path: (string | number)[],
  pruneEmptyAncestors = false,
): void {
  // Record each (container, key) hop on the way down so we can prune upward
  // after deleting the leaf.
  const chain: Array<{ container: Record<string, unknown>; key: string }> = [];
  let current: unknown = obj;
  for (let i = 0; i < path.length - 1; i++) {
    if (current == null || typeof current !== "object") return;
    const key = String(path[i]);
    chain.push({ container: current as Record<string, unknown>, key });
    current = (current as Record<string, unknown>)[key];
  }
  if (current == null || typeof current !== "object") return;
  delete (current as Record<string, unknown>)[String(path[path.length - 1])];

  if (!pruneEmptyAncestors) return;
  // Remove ancestors emptied by the deletion, deepest first; stop at the first
  // that still has keys.
  for (let i = chain.length - 1; i >= 0; i--) {
    const { container, key } = chain[i];
    const child = container[key];
    if (isPlainObject(child) && Object.keys(child).length === 0) {
      delete container[key];
    } else {
      break;
    }
  }
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
  "daemon.reapOrphanedSubprocesses":
    "daemon.reapOrphanedSubprocesses has been removed. The daemon now reaps " +
    "orphaned subprocesses automatically whenever it runs as PID 1 on Linux. " +
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
};

function emptyDefaultWorkspaceConfigMergeResult(): DefaultWorkspaceConfigMergeResult {
  return {
    hadOverlay: false,
    providedLlmProfileNames: new Set(),
    providedLlmActiveProfile: false,
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
/**
 * Whether an unconsumed onboarding overlay is waiting to be merged this boot.
 * The overlay file is renamed away on merge, so this is true for at most the
 * single boot that consumes it.
 */
export function hasPendingDefaultWorkspaceConfig(): boolean {
  const defaultConfigPath = process.env.VELLUM_DEFAULT_WORKSPACE_CONFIG_PATH;
  return Boolean(defaultConfigPath && existsSync(defaultConfigPath));
}

export function mergeDefaultWorkspaceConfig(): DefaultWorkspaceConfigMergeResult {
  if (!hasPendingDefaultWorkspaceConfig()) {
    return emptyDefaultWorkspaceConfigMergeResult();
  }
  const defaultConfigPath = process.env
    .VELLUM_DEFAULT_WORKSPACE_CONFIG_PATH as string;

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
  const mergeResult: DefaultWorkspaceConfigMergeResult = {
    hadOverlay: true,
    providedLlmProfileNames: new Set(
      providedProfiles ? Object.keys(providedProfiles) : [],
    ),
    providedLlmActiveProfile:
      llmDefaults != null &&
      Object.prototype.hasOwnProperty.call(llmDefaults, "activeProfile"),
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

  if (mergeResult.providedLlmProfileNames.size > 0) {
    // Default-config profile entries are authoritative fragments. Remove any
    // old same-name profile first so recursive merge does not leave stale
    // provider-specific leaves behind.
    const existingLlm = readPlainObject(existing.llm);
    const existingProfiles = readPlainObject(existingLlm?.profiles);
    if (existingProfiles) {
      for (const name of mergeResult.providedLlmProfileNames) {
        delete existingProfiles[name];
      }
    }
  }

  deepMergeOverwrite(existing, defaults as Record<string, unknown>);
  pruneSeededCallsiteDefaultsFromConfig(existing);

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
          // etc.) never iterates a non-record. Quarantine + fall through to
          // defaults.
          quarantineCorruptConfig(
            configPath,
            new Error(
              `config.json must contain a JSON object at the top level; got ${describeJsonShape(
                parsed,
              )}`,
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

    // Validate and apply defaults via Zod schema
    const config = validateWithSchema(fileConfig);

    // Snapshot the schema-defaulted config BEFORE deployment-context fills are
    // layered on — but only when the first-launch seed below will actually
    // persist it. Disk records user intent (schema defaults only), while the
    // in-memory `config` returned below carries the deployment-context fills as
    // this run's effective values.
    const willSeed = !configFileExisted && suppressConfigDiskWritesDepth === 0;

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
      // Refresh the last-known-good safety net with the effective config.
      // `validateWithSchema` captured a snapshot before these deployment-context
      // fills (e.g. IS_PLATFORM=true → managed OAuth service modes) were layered
      // on, so its snapshot reflects pre-fill schema defaults. The fills are part
      // of this run's effective configuration, so a later recovery must restore
      // them rather than flip a managed service mode back to its schema default.
      lastKnownGoodConfig = structuredClone(config);
    }

    // First-launch seed only: when config.json does not exist, write the
    // effective config to disk so users can discover and edit all available
    // options. Deployment-context service-mode defaults (e.g. IS_PLATFORM=true →
    // managed service modes) are included for discoverability, but the platform
    // embedding-provider intent is OMITTED entirely — not even persisted as the
    // schema default "auto". `fillContextDefaultsForMissingKeys` only fills a
    // leaf absent from disk, so persisting any provider value (including "auto")
    // would be read back as an explicit user choice on the next load and
    // permanently suppress re-applying the platform "gemini" default. Leaving
    // the leaf absent keeps the platform intent in-memory-only yet re-applied on
    // every load.
    //
    // When the file already exists, leave it alone — disk represents user
    // intent, while the in-memory `cached: AssistantConfig` (above) has all
    // schema defaults applied via `applyNestedDefaults`/`validateWithSchema`,
    // so consumers calling `getConfig().memory.v2.bm25_b` continue to receive
    // the schema default whenever the field is absent on disk. Contract: disk =
    // user intent, in-memory cache = effective values.
    if (willSeed) {
      try {
        const dir = dirname(configPath);
        if (!existsSync(dir)) {
          mkdirSync(dir, { recursive: true });
        }
        const seed = structuredClone(config);
        // Drop the deployment-context embedding provider so it is never
        // persisted (see above); the schema default re-applies in memory.
        delete (seed.memory.embeddings as { provider?: unknown }).provider;
        // Memory-v3 tuning knobs are globally-shipped defaults, not per-assistant
        // config: persist only `live` (genuine per-assistant state — some
        // workspaces predate the v3 migration and must not be flipped on) and let
        // every tuning knob resolve from the schema on load. This way a shipped
        // schema-default change reaches all assistants (mirrors the
        // embedding-provider strip above); migration
        // 119-strip-persisted-memory-v3-tuning-defaults handles already-seeded
        // configs.
        seed.memory.v3 = {
          live: seed.memory.v3.live,
        } as (typeof seed.memory)["v3"];
        // Strip dataDir (runtime-derived) from the persisted config
        const { dataDir: _, ...persistable } = seed;
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

export function getConfig(): AssistantConfig {
  return loadConfig();
}

/**
 * Read-only config accessor: returns the current config without creating
 * directories or writing files. Reads config.json if it exists on disk;
 * returns schema defaults otherwise. Unlike `getConfig()` / `loadConfig()`,
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
    try {
      fileConfig = JSON.parse(readFileSync(configPath, "utf-8"));
    } catch {
      return cloneDefaultConfig();
    }
  }

  return validateWithSchema(fileConfig);
}

export function invalidateConfigCache(): void {
  cached = null;
  cachedFileSignature = null;
  loading = false;
}

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
        `config.json must contain a JSON object at the top level; got ${describeJsonShape(
          parsed,
        )}`,
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
 * Test-only alias for `writeQuarantineNotice`. Exists so the sentinel write
 * (and its overwrite/idempotency semantics) can be exercised directly with a
 * deterministic quarantine path without widening the runtime surface. Not for
 * production use.
 */
export const _writeQuarantineNotice = writeQuarantineNotice;

/**
 * Test-only reset for the module-level last-known-good config safety net.
 * Exists so tests can exercise the first-load-after-startup salvage path (where
 * no last-known-good config exists yet) deterministically. Not for production
 * use: {@link invalidateConfigCache} deliberately preserves the safety net, so
 * production code never clears it.
 */
export function _resetLastKnownGoodConfigForTests(): void {
  lastKnownGoodConfig = null;
}
