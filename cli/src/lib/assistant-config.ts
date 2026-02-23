import { existsSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

export interface AssistantEntry {
  assistantId: string;
  runtimeUrl: string;
  baseDataDir?: string;
  bearerToken?: string;
  cloud: string;
  instanceId?: string;
  project?: string;
  region?: string;
  species?: string;
  sshUser?: string;
  zone?: string;
  hatchedAt?: string;
}

interface LockfileData {
  assistants?: AssistantEntry[];
  [key: string]: unknown;
}

function getBaseDir(): string {
  return process.env.BASE_DATA_DIR?.trim() || homedir();
}

function readLockfile(): LockfileData {
  const base = getBaseDir();
  const candidates = [
    join(base, ".vellum.lock.json"),
    join(base, ".vellum.lockfile.json"),
  ];
  for (const lockfilePath of candidates) {
    if (!existsSync(lockfilePath)) continue;
    try {
      const raw = readFileSync(lockfilePath, "utf-8");
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as LockfileData;
      }
    } catch {
      // Malformed lockfile; try next
    }
  }
  return {};
}

function writeLockfile(data: LockfileData): void {
  const lockfilePath = join(getBaseDir(), ".vellum.lock.json");
  writeFileSync(lockfilePath, JSON.stringify(data, null, 2) + "\n");
}

function readAssistants(): AssistantEntry[] {
  const data = readLockfile();
  const entries = data.assistants;
  if (!Array.isArray(entries)) {
    return [];
  }
  return entries.filter(
    (e) => typeof e.assistantId === "string" && typeof e.runtimeUrl === "string",
  );
}

function writeAssistants(entries: AssistantEntry[]): void {
  const data = readLockfile();
  data.assistants = entries;
  writeLockfile(data);
}

export function loadLatestAssistant(): AssistantEntry | null {
  const entries = readAssistants();
  if (entries.length === 0) {
    return null;
  }
  const sorted = [...entries].sort((a, b) => {
    const ta = a.hatchedAt ? new Date(a.hatchedAt).getTime() : 0;
    const tb = b.hatchedAt ? new Date(b.hatchedAt).getTime() : 0;
    return tb - ta;
  });
  return sorted[0];
}

export function findAssistantByName(name: string): AssistantEntry | null {
  const entries = readAssistants();
  return entries.find((e) => e.assistantId === name) ?? null;
}

export function removeAssistantEntry(assistantId: string): void {
  const entries = readAssistants();
  writeAssistants(entries.filter((e) => e.assistantId !== assistantId));
}

export function loadAllAssistants(): AssistantEntry[] {
  return readAssistants();
}

export function saveAssistantEntry(entry: AssistantEntry): void {
  const entries = readAssistants();
  entries.unshift(entry);
  writeAssistants(entries);
}
