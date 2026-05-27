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

const LOCAL_MODE_FALSY = new Set(["", "0", "false", "no"]);

export function isLocalMode(): boolean {
  const raw = import.meta.env.VITE_LOCAL_MODE;
  if (!raw) return false;
  return !LOCAL_MODE_FALSY.has(raw.toLowerCase());
}

export async function loadLockfile(): Promise<Lockfile> {
  try {
    const res = await fetch("/assistant/__local/lockfile");
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

export function isLocalAssistant(a: LockfileAssistant): boolean {
  return a.cloud !== "vellum" && a.resources?.gatewayPort != null;
}

export function getLocalAssistants(): LockfileAssistant[] {
  return getLockfile().assistants.filter(isLocalAssistant);
}

export function getPlatformAssistants(): LockfileAssistant[] {
  return getLockfile().assistants.filter((a) => a.cloud === "vellum");
}

function getActiveAssistant(): LockfileAssistant | undefined {
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
// URL helpers
// ---------------------------------------------------------------------------

export function gatewayProxyUrl(port: number): string {
  return `/assistant/__gateway/${port}`;
}

/**
 * Return the local gateway proxy URL for the selected assistant, or
 * `undefined` when not in local mode / no local assistant is selected.
 */
export function getLocalGatewayUrl(): string | undefined {
  if (!isLocalMode()) return undefined;
  const assistant = getSelectedAssistant();
  if (!assistant || !isLocalAssistant(assistant)) return undefined;
  return gatewayProxyUrl(assistant.resources!.gatewayPort);
}
