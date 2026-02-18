import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getRootDir } from '../util/platform.js';

export interface AssistantEntry {
  assistantId: string;
  runtimeUrl: string;
  bearerToken?: string;
  project?: string;
  zone?: string;
  species?: string;
  sshUser?: string;
  hatchedAt?: string;
}

interface LockfileData {
  assistants?: AssistantEntry[];
  [key: string]: unknown;
}

function getLockfilePath(): string {
  return join(getRootDir(), 'hatch', 'lockfile.json');
}

function readLockfile(): LockfileData {
  const lockfilePath = getLockfilePath();
  if (!existsSync(lockfilePath)) {
    return {};
  }

  try {
    const raw = readFileSync(lockfilePath, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as LockfileData;
    }
  } catch {
    // Malformed lockfile; return empty
  }
  return {};
}

function writeLockfile(data: LockfileData): void {
  const lockfilePath = getLockfilePath();
  const lockfileDir = dirname(lockfilePath);
  mkdirSync(lockfileDir, { recursive: true });
  writeFileSync(lockfilePath, JSON.stringify(data, null, 2) + '\n');
}

function readAssistants(): AssistantEntry[] {
  const data = readLockfile();
  const entries = data.assistants;
  if (!Array.isArray(entries)) {
    return [];
  }
  return entries.filter(
    (e) => typeof e.assistantId === 'string' && typeof e.runtimeUrl === 'string',
  );
}

function writeAssistants(entries: AssistantEntry[]): void {
  const data = readLockfile();
  data.assistants = entries;
  writeLockfile(data);
}

export function saveAssistantEntry(entry: AssistantEntry): void {
  const entries = readAssistants();
  entries.unshift(entry);
  writeAssistants(entries);
}
