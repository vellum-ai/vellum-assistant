// Transport: Vite dev middleware for now. In Electron, swap to IPC (window.electronAPI.readLockfile).

import {
  getLocalSetting,
  removeLocalSetting,
  setLocalSetting,
} from "@/lib/local-settings";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LocalAssistantResources {
  gatewayPort: number;
  daemonPort: number;
}

export interface LockfileAssistant {
  assistantId: string;
  name?: string;
  cloud: string;
  runtimeUrl: string;
  species?: string;
  hatchedAt?: string;
  resources?: LocalAssistantResources;
}

export interface Lockfile {
  assistants: LockfileAssistant[];
  activeAssistant: string | null;
}

// ---------------------------------------------------------------------------
// Module-level cache
// ---------------------------------------------------------------------------

let lockfile: Lockfile | null = null;

const EMPTY_LOCKFILE: Lockfile = { assistants: [], activeAssistant: null };

const LOCKFILE_STORAGE_KEY = "local:lockfile";
const SELECTED_ASSISTANT_STORAGE_KEY = "local:selectedAssistantId";

// ---------------------------------------------------------------------------
// Core helpers
// ---------------------------------------------------------------------------

export function isLocalMode(): boolean {
  return !!import.meta.env.VITE_LOCAL_MODE;
}

export async function loadLockfile(): Promise<Lockfile> {
  try {
    const res = await fetch("/__local/lockfile");
    if (!res.ok) throw new Error(`lockfile fetch failed: ${res.status}`);
    const data: Lockfile = await res.json();
    lockfile = data;
    setLocalSetting(LOCKFILE_STORAGE_KEY, JSON.stringify(data));
    return data;
  } catch {
    lockfile = { ...EMPTY_LOCKFILE };
    return lockfile;
  }
}

export function getLockfile(): Lockfile {
  if (lockfile) return lockfile;

  const stored = getLocalSetting(LOCKFILE_STORAGE_KEY, "");
  if (stored) {
    try {
      lockfile = JSON.parse(stored) as Lockfile;
      return lockfile;
    } catch {
      // Corrupted storage -- fall through to empty lockfile.
    }
  }

  lockfile = { ...EMPTY_LOCKFILE };
  return lockfile;
}

// ---------------------------------------------------------------------------
// Assistant queries
// ---------------------------------------------------------------------------

export function getLocalAssistants(): LockfileAssistant[] {
  return getLockfile().assistants.filter(
    (a) => a.cloud !== "vellum" && a.resources?.gatewayPort != null,
  );
}

export function getPlatformAssistants(): LockfileAssistant[] {
  return getLockfile().assistants.filter((a) => a.cloud === "vellum");
}

export function getActiveAssistant(): LockfileAssistant | undefined {
  const lf = getLockfile();
  const active = lf.assistants.find(
    (a) => a.assistantId === lf.activeAssistant,
  );
  if (active) return active;
  if (lf.assistants.length === 1) return lf.assistants[0];
  return undefined;
}

export function getSelectedAssistant(): LockfileAssistant | undefined {
  const selectedId = getLocalSetting(SELECTED_ASSISTANT_STORAGE_KEY, "");
  if (selectedId) {
    const found = getLockfile().assistants.find(
      (a) => a.assistantId === selectedId,
    );
    if (found) return found;
  }
  return getActiveAssistant();
}

export function setSelectedAssistantId(id: string): void {
  setLocalSetting(SELECTED_ASSISTANT_STORAGE_KEY, id);
}

export function clearSelectedAssistant(): void {
  removeLocalSetting(SELECTED_ASSISTANT_STORAGE_KEY);
}

// ---------------------------------------------------------------------------
// Write operations
// ---------------------------------------------------------------------------

export async function writeLockfile(patch: Partial<Lockfile>): Promise<void> {
  await fetch("/__local/lockfile", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  await loadLockfile();
}

// ---------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------

export function gatewayProxyUrl(port: number): string {
  return `/__gateway/${port}`;
}
