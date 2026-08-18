import fs from "node:fs";
import path from "node:path";

import {
  parseLockfile,
  resolveCloud,
  type Lockfile,
} from "./lockfile-contract";
import { withLockfileLock } from "./lockfile-lock";
import { stripSensitiveFields } from "./util";

export type LockfileResult =
  { ok: true; data: Lockfile } | { ok: false; status: number; error?: string };

export function getLockfileData(lockfilePaths: string[]): LockfileResult {
  let raw: string | undefined;
  for (const candidate of lockfilePaths) {
    try {
      raw = fs.readFileSync(candidate, "utf-8");
      break;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        return { ok: false, status: 500 };
      }
    }
  }

  if (!raw) {
    return { ok: true, data: { assistants: [], activeAssistant: null } };
  }

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { ok: false, status: 500 };
  }
  stripSensitiveFields(data);
  return { ok: true, data: parseLockfile(data) };
}

/**
 * Whether the lockfile records this assistant as a paired entry. Paired
 * entries have no local daemon, so guardian-token failure guidance must say
 * re-pair rather than hatch/wake.
 */
export function isPairedLockfileEntry(
  lockfilePaths: string[],
  assistantId: string,
): boolean {
  const lockfile = readRawLockfile(lockfilePaths);
  const assistants = Array.isArray(lockfile.assistants)
    ? (lockfile.assistants as Array<Record<string, unknown>>)
    : [];
  return assistants.some(
    (assistant) =>
      assistant?.assistantId === assistantId &&
      (resolveCloud(assistant) === "paired" || assistant.paired === true),
  );
}

export type WriteResult =
  | { ok: true; lockfile: Lockfile }
  | { ok: false; status: number; error: string };

/** 423 Locked: the cross-process advisory lock could not be acquired. */
function lockFailure(error: string): WriteResult {
  return { ok: false, status: 423, error };
}

/**
 * Read the first parseable lockfile as raw JSON (unknown fields intact) for a
 * read-modify-write cycle; an unreadable file yields an empty lockfile.
 */
export function readRawLockfile(
  lockfilePaths: string[],
): Record<string, unknown> {
  for (const candidate of lockfilePaths) {
    try {
      return JSON.parse(fs.readFileSync(candidate, "utf-8")) as Record<
        string,
        unknown
      >;
    } catch {
      // continue
    }
  }
  return { assistants: [], activeAssistant: null };
}

export type RawLockfileReadResult =
  | { ok: true; lockfile: Record<string, unknown> }
  | { ok: false; error: string };

/**
 * Like {@link readRawLockfile}, but a file that exists and cannot be read or
 * parsed refuses instead of degrading to the empty registry. Missing or empty
 * files still yield the empty registry. Use for writes that must never
 * replace a registry they could not actually read.
 */
export function readRawLockfileStrict(
  lockfilePaths: string[],
): RawLockfileReadResult {
  for (const candidate of lockfilePaths) {
    let raw: string;
    try {
      raw = fs.readFileSync(candidate, "utf-8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      return { ok: false, error: `Failed to read lockfile: ${err}` };
    }
    if (raw.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      return { ok: false, error: `Failed to parse lockfile: ${err}` };
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return { ok: false, error: "Lockfile is not a JSON object" };
    }
    return { ok: true, lockfile: parsed as Record<string, unknown> };
  }
  return { ok: true, lockfile: { assistants: [], activeAssistant: null } };
}

/** The validated, sensitive-field-stripped wire view of a raw lockfile. */
function toWireLockfile(lockfile: Record<string, unknown>): Lockfile {
  const stripped = JSON.parse(JSON.stringify(lockfile)) as Record<
    string,
    unknown
  >;
  stripSensitiveFields(stripped);
  return parseLockfile(stripped);
}

/**
 * Atomically persist a raw lockfile (write-to-temp + rename) and return the
 * validated, sensitive-field-stripped view of what was written.
 */
export function writeRawLockfile(
  lockfilePaths: string[],
  lockfile: Record<string, unknown>,
): WriteResult {
  const writePath = lockfilePaths[0]!;
  try {
    const dir = path.dirname(writePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${writePath}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(lockfile, null, 2));
    fs.renameSync(tmp, writePath);
  } catch (err) {
    return {
      ok: false,
      status: 500,
      error: `Failed to write lockfile: ${err}`,
    };
  }

  return { ok: true, lockfile: toWireLockfile(lockfile) };
}

/**
 * Rename an existing assistant entry, never creating one. Unlike the upserts,
 * a missing entry refuses (404) and an unreadable on-disk file refuses (409)
 * instead of being treated as an empty registry, so a stale renderer cache
 * can neither resurrect a retired assistant nor replace a registry it could
 * not read with a skeleton row. Never touches `activeAssistant`. The whole
 * read-check-write runs under the shared advisory lock so a concurrent writer
 * (e.g. a CLI retire) cannot be clobbered by this snapshot; lock contention
 * refuses (423) without writing.
 */
export function renameLockfileAssistantIfPresent(
  lockfilePaths: string[],
  assistantId: string,
  name: string,
): WriteResult {
  if (typeof assistantId !== "string" || assistantId === "") {
    return { ok: false, status: 400, error: "Missing assistantId" };
  }
  if (typeof name !== "string" || name === "") {
    return { ok: false, status: 400, error: "Missing name" };
  }

  const locked = withLockfileLock(lockfilePaths, (): WriteResult => {
    const read = readRawLockfileStrict(lockfilePaths);
    if (!read.ok) {
      return { ok: false, status: 409, error: read.error };
    }
    const lockfile = read.lockfile;
    const assistants = Array.isArray(lockfile.assistants)
      ? (lockfile.assistants as Array<Record<string, unknown>>)
      : [];
    const idx = assistants.findIndex((a) => a?.assistantId === assistantId);
    if (idx < 0) {
      return {
        ok: false,
        status: 404,
        error: "No lockfile entry for this assistant",
      };
    }
    if (assistants[idx]!.name === name) {
      return { ok: true, lockfile: toWireLockfile(lockfile) };
    }
    assistants[idx] = { ...assistants[idx], name };
    lockfile.assistants = assistants;
    return writeRawLockfile(lockfilePaths, lockfile);
  });
  return locked.ok ? locked.value : lockFailure(locked.error);
}

export function upsertLockfileAssistant(
  lockfilePaths: string[],
  assistant: Record<string, unknown>,
  activeAssistant: string | undefined,
): WriteResult {
  if (!assistant || typeof assistant.assistantId !== "string") {
    return { ok: false, status: 400, error: "Missing assistant.assistantId" };
  }

  const locked = withLockfileLock(lockfilePaths, (): WriteResult => {
    const lockfile = readRawLockfile(lockfilePaths);
    const assistants = Array.isArray(lockfile.assistants)
      ? lockfile.assistants
      : [];
    const existingIdx = assistants.findIndex(
      (a: Record<string, unknown>) => a?.assistantId === assistant.assistantId,
    );
    if (existingIdx >= 0) {
      assistants[existingIdx] = { ...assistants[existingIdx], ...assistant };
    } else {
      assistants.push(assistant);
    }
    lockfile.assistants = assistants;
    if (activeAssistant !== undefined) {
      lockfile.activeAssistant = activeAssistant;
    }

    return writeRawLockfile(lockfilePaths, lockfile);
  });
  return locked.ok ? locked.value : lockFailure(locked.error);
}

const PAIRED_LOCKFILE_WRITE_ERROR =
  "Paired assistant identity can only be changed through the connect flow";

/**
 * Apply a renderer-originated lockfile upsert without allowing it to create,
 * retarget, or reclassify a paired assistant. Existing paired entries may
 * still update non-security fields and become the active assistant.
 */
export function upsertRendererLockfileAssistant(
  lockfilePaths: string[],
  assistant: Record<string, unknown>,
  activeAssistant: string | undefined,
): WriteResult {
  if (!assistant || typeof assistant.assistantId !== "string") {
    return { ok: false, status: 400, error: "Missing assistant.assistantId" };
  }

  // Lock spans the paired-guard read and the upsert (which reenters) so the
  // guard cannot be judged against a snapshot another writer replaces.
  const locked = withLockfileLock(lockfilePaths, (): WriteResult => {
    const lockfile = readRawLockfile(lockfilePaths);
    const assistants = Array.isArray(lockfile.assistants)
      ? (lockfile.assistants as Array<Record<string, unknown>>)
      : [];
    const existing = assistants.find(
      (entry) => entry?.assistantId === assistant.assistantId,
    );
    const merged = { ...existing, ...assistant };
    const existingIsPaired =
      existing != null &&
      (resolveCloud(existing) === "paired" || existing.paired === true);
    const mergedIsPaired =
      resolveCloud(merged) === "paired" || merged.paired === true;

    if (!existingIsPaired && mergedIsPaired) {
      return { ok: false, status: 403, error: PAIRED_LOCKFILE_WRITE_ERROR };
    }
    if (
      existingIsPaired &&
      (resolveCloud(merged) !== "paired" ||
        merged.runtimeUrl !== existing.runtimeUrl ||
        merged.paired !== existing.paired)
    ) {
      return { ok: false, status: 403, error: PAIRED_LOCKFILE_WRITE_ERROR };
    }

    return upsertLockfileAssistant(lockfilePaths, assistant, activeAssistant);
  });
  return locked.ok ? locked.value : lockFailure(locked.error);
}

export function isActiveAssistant(
  lockfilePaths: string[],
  assistantId: string,
): boolean {
  for (const candidate of lockfilePaths) {
    try {
      const data = JSON.parse(fs.readFileSync(candidate, "utf-8")) as Record<
        string,
        unknown
      >;
      if (data.activeAssistant === assistantId) return true;
      const assistants = data.assistants;
      if (!Array.isArray(assistants) || assistants.length !== 1) return false;
      const [onlyAssistant] = assistants as Array<Record<string, unknown>>;
      return onlyAssistant?.assistantId === assistantId;
    } catch {
      continue;
    }
  }
  return false;
}

export function replacePlatformAssistants(
  lockfilePaths: string[],
  platformAssistants: Array<Record<string, unknown>>,
  organizationId?: string,
): WriteResult {
  if (
    platformAssistants.some(
      (assistant) =>
        typeof assistant?.assistantId !== "string" ||
        assistant.assistantId === "" ||
        resolveCloud(assistant) !== "vellum" ||
        assistant.paired === true,
    )
  ) {
    return {
      ok: false,
      status: 403,
      error: "Platform sync only accepts platform assistants",
    };
  }

  const locked = withLockfileLock(lockfilePaths, (): WriteResult => {
    const lockfile = readRawLockfile(lockfilePaths);
    const existing = Array.isArray(lockfile.assistants)
      ? lockfile.assistants
      : [];
    const syncedIds = new Set(platformAssistants.map((a) => a.assistantId));
    // Org-scoped sync preserves other orgs' platform entries; no org full-replaces.
    const preserved = existing.filter((a: Record<string, unknown>) => {
      if (a?.cloud !== "vellum") return true;
      if (syncedIds.has(a.assistantId)) return false;
      return organizationId != null && a.organizationId !== organizationId;
    });
    lockfile.assistants = [...preserved, ...platformAssistants];

    const active = lockfile.activeAssistant as string | null;
    if (active) {
      const stillExists = (
        lockfile.assistants as Array<Record<string, unknown>>
      ).some((a) => a.assistantId === active);
      if (!stillExists) lockfile.activeAssistant = null;
    }

    return writeRawLockfile(lockfilePaths, lockfile);
  });
  return locked.ok ? locked.value : lockFailure(locked.error);
}
