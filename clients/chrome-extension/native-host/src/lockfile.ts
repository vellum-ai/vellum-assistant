/**
 * Lockfile reader for the Chrome native messaging helper.
 *
 * Resolves the environment-aware lockfile path(s), parses the
 * `assistants[]` array and `activeAssistant` field, and returns a
 * normalized assistant summary shape that downstream consumers (e.g. the
 * `list_assistants` frame handler and the assistant-scoped `request_token`
 * path) can use without coupling to the full lockfile schema.
 *
 * Production path: `~/.vellum.lock.json` (preferred) with fallback to
 * `~/.vellum.lockfile.json` (legacy). Non-production environments store
 * the lockfile at `$XDG_CONFIG_HOME/vellum-<env>/lockfile.json`.
 *
 * The path resolution mirrors `getLockfilePaths()` in
 * `cli/src/lib/environments/paths.ts`. Native host is a standalone binary
 * with its own build, so the logic is replicated inline rather than
 * imported.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Production lockfile filenames, checked in priority order.
 * `.vellum.lock.json` is the current name; `.vellum.lockfile.json` is the
 * legacy name kept for backwards compatibility with older installs.
 */
const PRODUCTION_LOCKFILE_NAMES = [
  ".vellum.lock.json",
  ".vellum.lockfile.json",
] as const;

/**
 * Non-production environment names that map to `$XDG_CONFIG_HOME/vellum-<env>/`.
 * Anything not in this set (including typos like `foo`) falls back to the
 * production path. Mirrors `SEEDS` in `cli/src/lib/environments/seeds.ts`
 * and `KNOWN_ENVIRONMENTS` in `assistant/src/util/platform.ts`. Drift
 * between these three sites is caught at test time by
 * `cli/src/__tests__/env-drift.test.ts`. Fast follow: hoist the shared
 * list into a `packages/environments` package so all three sites import
 * from one place.
 */
const NON_PRODUCTION_ENVIRONMENTS: ReadonlySet<string> = new Set([
  "dev",
  "staging",
  "test",
  "local",
]);

/** Normalized summary of a single assistant from the lockfile. */
export interface AssistantSummary {
  assistantId: string;
  cloud: string;
  runtimeUrl: string;
  /** The daemon HTTP port for this assistant, derived from
   *  `resources.daemonPort` when present. `undefined` when the entry
   *  has no resources block (e.g. remote/cloud assistants). */
  daemonPort: number | undefined;
  /** Whether this assistant is the currently active one
   *  (matches `activeAssistant` in the lockfile root). */
  isActive: boolean;
}

/** Result of reading the lockfile's assistant inventory. */
export interface LockfileInventory {
  assistants: AssistantSummary[];
  activeAssistantId: string | null;
}

/**
 * Raw lockfile shape — just enough to extract assistant entries.
 * Kept deliberately loose to tolerate forward-compatible fields.
 */
interface RawLockfile {
  assistants?: unknown[];
  activeAssistant?: string;
  [key: string]: unknown;
}

/** Minimal shape we need from a raw assistant entry. */
interface RawAssistantEntry {
  assistantId?: unknown;
  cloud?: unknown;
  runtimeUrl?: unknown;
  resources?: { daemonPort?: unknown; [key: string]: unknown };
  [key: string]: unknown;
}

/**
 * Resolve the candidate lockfile paths, in priority order, based on the
 * current `VELLUM_ENVIRONMENT`.
 *
 * - Production (unset/empty/unknown env name): returns
 *   `[<dir>/.vellum.lock.json, <dir>/.vellum.lockfile.json]` where `<dir>`
 *   is `VELLUM_LOCKFILE_DIR` if set, else the user's home directory.
 * - Non-production (`dev`/`staging`/`test`/`local`): returns a single
 *   `[<dir>/lockfile.json]` where `<dir>` is `VELLUM_LOCKFILE_DIR` if set,
 *   else `$XDG_CONFIG_HOME/vellum-<env>` (falling back to
 *   `~/.config/vellum-<env>` when `XDG_CONFIG_HOME` is unset).
 *
 * Mirrors `getLockfilePaths()` in `cli/src/lib/environments/paths.ts`.
 * Unknown env names fall back to production silently — browser users
 * don't see warnings.
 */
function getLockfileCandidates(): string[] {
  const lockfileDirOverride = process.env.VELLUM_LOCKFILE_DIR?.trim();
  const rawEnv = process.env.VELLUM_ENVIRONMENT?.trim() || "production";
  const isNonProd = NON_PRODUCTION_ENVIRONMENTS.has(rawEnv);

  if (!isNonProd) {
    const dir = lockfileDirOverride || homedir();
    return PRODUCTION_LOCKFILE_NAMES.map((name) => join(dir, name));
  }

  const xdgConfigHome =
    process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config");
  const dir = lockfileDirOverride || join(xdgConfigHome, `vellum-${rawEnv}`);
  return [join(dir, "lockfile.json")];
}

/**
 * Read and parse the lockfile from the first candidate path that exists
 * and contains valid JSON. Returns `null` if no valid lockfile is found.
 */
function readRawLockfile(): RawLockfile | null {
  for (const filePath of getLockfileCandidates()) {
    try {
      const raw = readFileSync(filePath, "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as RawLockfile;
      }
    } catch {
      // File doesn't exist or isn't valid JSON; try next candidate.
    }
  }
  return null;
}

/**
 * Type-guard: returns `true` if the raw entry has the minimum fields
 * needed to produce an `AssistantSummary`.
 */
function isValidEntry(
  entry: unknown,
): entry is RawAssistantEntry & {
  assistantId: string;
  runtimeUrl: string;
  cloud: string;
} {
  if (!entry || typeof entry !== "object") return false;
  const e = entry as RawAssistantEntry;
  return (
    typeof e.assistantId === "string" &&
    typeof e.runtimeUrl === "string" &&
    typeof e.cloud === "string"
  );
}

/**
 * Extract `daemonPort` from a raw entry's `resources` block.
 * Returns `undefined` if the block is absent or the port is not a
 * positive finite integer.
 */
function extractDaemonPort(entry: RawAssistantEntry): number | undefined {
  const res = entry.resources;
  if (!res || typeof res !== "object") return undefined;
  const port = res.daemonPort;
  if (typeof port !== "number") return undefined;
  if (!Number.isFinite(port) || port <= 0 || port >= 65536) return undefined;
  return port;
}

/**
 * Read the lockfile and return a normalized assistant inventory.
 *
 * This is the main entry point for consumers. It handles:
 * - Fallback from `.vellum.lock.json` to `.vellum.lockfile.json`
 * - Filtering entries that lack required fields
 * - Extracting `daemonPort` from `resources` when present
 * - Resolving which assistant is active
 */
export function readAssistantInventory(): LockfileInventory {
  const raw = readRawLockfile();
  if (!raw) {
    return { assistants: [], activeAssistantId: null };
  }

  const activeAssistantId =
    typeof raw.activeAssistant === "string" ? raw.activeAssistant : null;

  const rawEntries = Array.isArray(raw.assistants) ? raw.assistants : [];

  const assistants: AssistantSummary[] = rawEntries
    .filter(isValidEntry)
    .map((entry) => ({
      assistantId: entry.assistantId,
      cloud: entry.cloud,
      runtimeUrl: entry.runtimeUrl,
      daemonPort: extractDaemonPort(entry),
      isActive: entry.assistantId === activeAssistantId,
    }));

  return { assistants, activeAssistantId };
}

/**
 * Look up a specific assistant by ID and return its daemon port.
 * Returns `undefined` if the assistant is not found or has no daemon port.
 *
 * This is a convenience wrapper used by the `request_token` handler when
 * an `assistantId` is provided in the request frame.
 */
export function resolveDaemonPort(assistantId: string): number | undefined {
  const { assistants } = readAssistantInventory();
  const match = assistants.find((a) => a.assistantId === assistantId);
  return match?.daemonPort;
}
