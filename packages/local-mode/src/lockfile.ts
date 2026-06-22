import fs from "node:fs";
import path from "node:path";

import { parseLockfile, type Lockfile } from "./lockfile-contract";
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

export type WriteResult =
  | { ok: true; lockfile: Lockfile }
  | { ok: false; status: number; error: string };

export function upsertLockfileAssistant(
  lockfilePaths: string[],
  assistant: Record<string, unknown>,
  activeAssistant: string | undefined,
): WriteResult {
  if (!assistant || typeof assistant.assistantId !== "string") {
    return { ok: false, status: 400, error: "Missing assistant.assistantId" };
  }

  let lockfile: Record<string, unknown> = { assistants: [], activeAssistant: null };
  for (const candidate of lockfilePaths) {
    try {
      lockfile = JSON.parse(fs.readFileSync(candidate, "utf-8")) as Record<string, unknown>;
      break;
    } catch {
      // continue
    }
  }

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

  const stripped = JSON.parse(JSON.stringify(lockfile)) as Record<string, unknown>;
  stripSensitiveFields(stripped);
  return { ok: true, lockfile: parseLockfile(stripped) };
}

export function isActiveAssistant(
  lockfilePaths: string[],
  assistantId: string,
): boolean {
  for (const candidate of lockfilePaths) {
    try {
      const data = JSON.parse(fs.readFileSync(candidate, "utf-8")) as Record<string, unknown>;
      return data.activeAssistant === assistantId;
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
  let lockfile: Record<string, unknown> = { assistants: [], activeAssistant: null };
  for (const candidate of lockfilePaths) {
    try {
      lockfile = JSON.parse(fs.readFileSync(candidate, "utf-8")) as Record<string, unknown>;
      break;
    } catch {
      // continue
    }
  }

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

  const stripped = JSON.parse(JSON.stringify(lockfile)) as Record<string, unknown>;
  stripSensitiveFields(stripped);
  return { ok: true, lockfile: parseLockfile(stripped) };
}
