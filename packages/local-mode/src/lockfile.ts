import fs from "node:fs";
import path from "node:path";

import {
  parseLockfile,
  resolveCloud,
  type Lockfile,
} from "./lockfile-contract";
import { stripSensitiveFields } from "./util";

export type LockfileResult =
  | { ok: true; data: Lockfile }
  | { ok: false; status: number; error?: string };

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
    return { ok: false, status: 500, error: `Failed to write lockfile: ${err}` };
  }

  const stripped = JSON.parse(JSON.stringify(lockfile)) as Record<
    string,
    unknown
  >;
  stripSensitiveFields(stripped);
  return { ok: true, lockfile: parseLockfile(stripped) };
}

export function upsertLockfileAssistant(
  lockfilePaths: string[],
  assistant: Record<string, unknown>,
  activeAssistant: string | undefined,
): WriteResult {
  if (!assistant || typeof assistant.assistantId !== "string") {
    return { ok: false, status: 400, error: "Missing assistant.assistantId" };
  }

  const lockfile = readRawLockfile(lockfilePaths);
  const assistants = Array.isArray(lockfile.assistants) ? lockfile.assistants : [];
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

  const lockfile = readRawLockfile(lockfilePaths);
  const existing = Array.isArray(lockfile.assistants) ? lockfile.assistants : [];
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
    const stillExists = (lockfile.assistants as Array<Record<string, unknown>>).some(
      (a) => a.assistantId === active,
    );
    if (!stillExists) lockfile.activeAssistant = null;
  }

  return writeRawLockfile(lockfilePaths, lockfile);
}
