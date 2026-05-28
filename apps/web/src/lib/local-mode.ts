// Transport: Vite dev middleware for now. In Electron, swap to IPC (window.electronAPI.readLockfile).

import {
  getLocalSetting,
  removeLocalSetting,
  setLocalSetting,
} from "@/lib/local-settings";
import {
  clearGatewayToken,
  ensureGatewayToken,
  getGatewayToken,
  getLocalTokenUrl,
} from "@/lib/auth/gateway-session";
import { setSelfHostedConnection } from "@/lib/self-hosted/connection";

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

const PLATFORM_MODE_TRUTHY = new Set(["1", "true", "yes"]);

export function isLocalMode(): boolean {
  const raw = import.meta.env.VITE_PLATFORM_MODE;
  if (!raw) return true;
  return !PLATFORM_MODE_TRUTHY.has(raw.toLowerCase());
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
// Hatch
// ---------------------------------------------------------------------------

export interface LocalHatchResult {
  ok: boolean;
  assistantId?: string;
  error?: string;
}

/**
 * Trigger a local assistant hatch via the dev server middleware.
 *
 * Transport: fetch to Vite dev middleware endpoint.
 * In Electron, replace with: window.electronAPI.hatchAssistant(species) (LUM-1997)
 */
export async function hatchLocalAssistant(
  species: string = "vellum",
): Promise<LocalHatchResult> {
  const res = await fetch("/assistant/__local/hatch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ species }),
  });
  return res.json() as Promise<LocalHatchResult>;
}

/**
 * Write an assistant entry to the lockfile on disk and refresh the cache.
 *
 * Transport: fetch to Vite dev middleware endpoint.
 * In Electron, replace with: window.electronAPI.saveLockfileAssistant(entry) (LUM-1998)
 */
export async function saveLockfileAssistant(
  assistant: { assistantId: string; cloud: string; runtimeUrl: string; hatchedAt: string },
): Promise<void> {
  const res = await fetch("/assistant/__local/lockfile", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ assistant, activeAssistant: assistant.assistantId }),
  });
  if (res.ok) {
    const { lockfile: updated } = (await res.json()) as { lockfile: Lockfile };
    lockfile = updated;
    setLocalSetting(LOCKFILE_STORAGE_KEY, JSON.stringify(updated));
  }
}

// ---------------------------------------------------------------------------
// Retire
// ---------------------------------------------------------------------------

export interface LocalRetireResult {
  ok: boolean;
  error?: string;
}

/**
 * Retire a local assistant via the dev server middleware (shells out to CLI).
 *
 * Transport: fetch to Vite dev middleware endpoint.
 * In Electron, replace with: window.electronAPI.retireAssistant(assistantId) (LUM-2000)
 */
export async function retireLocalAssistant(
  assistantId: string,
): Promise<LocalRetireResult> {
  const res = await fetch("/assistant/__local/retire", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ assistantId }),
  });
  const result = (await res.json()) as LocalRetireResult;
  if (result.ok) {
    clearSelectedAssistant();
    clearGatewayToken();
    setSelfHostedConnection(null);
    await loadLockfile();
  }
  return result;
}

// ---------------------------------------------------------------------------
// Assistant queries
// ---------------------------------------------------------------------------

/** In Electron, replace with: window.electronAPI.hasAssistants() (LUM-1998) */
export function hasAssistants(): boolean {
  return getLockfile().assistants.length > 0;
}

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

// ---------------------------------------------------------------------------
// Guardian token
// ---------------------------------------------------------------------------

/**
 * Fetch the guardian access token for a local assistant from the Vite dev
 * middleware. The middleware reads the token from disk and handles refresh
 * via the CLI if the access token is expired.
 *
 * Transport: fetch to Vite dev middleware endpoint.
 * In Electron, replace with IPC call to main process.
 */
export async function fetchGuardianToken(assistantId: string): Promise<string> {
  const res = await fetch(`/assistant/__local/guardian-token/${encodeURIComponent(assistantId)}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error ?? `Guardian token request failed: ${res.status}`);
  }
  const { accessToken } = (await res.json()) as { accessToken: string };
  return accessToken;
}

// ---------------------------------------------------------------------------
// Gateway connection setup
// ---------------------------------------------------------------------------

/**
 * Acquire a gateway token and prime the self-hosted connection for the
 * selected local assistant.
 *
 * Transport: fetch to Vite dev middleware gateway proxy.
 * In Electron, replace with direct IPC token acquisition. (LUM-1999)
 */
export async function primeLocalGatewayConnection(): Promise<void> {
  const tokenUrl = getLocalTokenUrl();
  if (!tokenUrl) return;
  const assistant = getSelectedAssistant();
  const guardianToken = assistant ? await fetchGuardianToken(assistant.assistantId) : undefined;
  await ensureGatewayToken(tokenUrl, guardianToken);
  const localGateway = getLocalGatewayUrl();
  if (!localGateway) return;
  setSelfHostedConnection({
    url: `${window.location.origin}${localGateway}`,
    token: getGatewayToken(),
  });
}
