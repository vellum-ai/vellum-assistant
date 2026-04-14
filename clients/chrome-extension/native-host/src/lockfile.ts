/**
 * Lockfile reader for the Chrome native messaging helper.
 *
 * Reads `~/.vellum.lock.json` (preferred) with fallback to
 * `~/.vellum.lockfile.json` (legacy), parses the `assistants[]` array and
 * `activeAssistant` field, and returns a normalized assistant summary shape
 * that downstream consumers (e.g. the `list_assistants` frame handler and
 * the assistant-scoped `request_token` path) can use without coupling to
 * the full lockfile schema.
 *
 * The lockfile filenames and priority order are kept in sync with
 * `PRODUCTION_LOCKFILE_NAMES` in `cli/src/lib/environments/paths.ts`.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Lockfile candidate filenames, checked in priority order.
 * `.vellum.lock.json` is the current name; `.vellum.lockfile.json` is the
 * legacy name kept for backwards compatibility with older installs.
 *
 * Mirrors `PRODUCTION_LOCKFILE_NAMES` in `cli/src/lib/environments/paths.ts`.
 */
const LOCKFILE_NAMES = [
  ".vellum.lock.json",
  ".vellum.lockfile.json",
] as const;

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
 * Resolve the directory containing the lockfile. Respects
 * `VELLUM_LOCKFILE_DIR` for testing, falling back to the user's home
 * directory.
 */
function getLockfileDir(): string {
  return process.env.VELLUM_LOCKFILE_DIR?.trim() || homedir();
}

/**
 * Read and parse the lockfile from the first candidate path that exists
 * and contains valid JSON. Returns `null` if no valid lockfile is found.
 */
function readRawLockfile(): RawLockfile | null {
  const base = getLockfileDir();
  for (const name of LOCKFILE_NAMES) {
    const filePath = join(base, name);
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
