import {
  getLocalSetting,
  removeLocalSetting,
  setLocalSetting,
} from "@/utils/local-settings";
import {
  clearGatewayToken,
  ensureGatewayToken,
  getGatewayToken,
  getLocalTokenUrl,
} from "@/lib/auth/gateway-session";
import { setSelfHostedConnection } from "@/lib/self-hosted/connection";
import {
  loadLockfileHost,
  replacePlatformAssistantsHost,
  retireLocalAssistantHost,
  saveLockfileAssistantHost,
} from "@/runtime/local-mode-host";
import type {
  Lockfile,
  LockfileAssistant,
  LocalAssistantResources,
  LocalRetireResult,
} from "@/runtime/local-mode-host";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// The lockfile shape is the transport contract shared by the Electron IPC and
// dev-server branches, so the seam owns it; re-exported here for the renderer
// features that read and model assistants.
export type {
  Lockfile,
  LockfileAssistant,
  LocalAssistantResources,
  LocalRetireResult,
};

// ---------------------------------------------------------------------------
// Module-level cache
// ---------------------------------------------------------------------------

let lockfile: Lockfile | null = null;

const EMPTY_LOCKFILE: Lockfile = { assistants: [], activeAssistant: null };

const LOCKFILE_STORAGE_KEY = "vellum:local:lockfile";
const SELECTED_ASSISTANT_STORAGE_KEY = "vellum:local:selectedAssistantId";

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
    const data = await loadLockfileHost();
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
// Lockfile mutation
// ---------------------------------------------------------------------------

/**
 * Write an assistant entry to the lockfile on disk and refresh the cache,
 * making it the active assistant. Silently no-ops on a write failure, matching
 * the prior behaviour where the cache is only updated on success.
 */
export async function saveLockfileAssistant(
  assistant: { assistantId: string; cloud: string; runtimeUrl: string; hatchedAt: string },
): Promise<void> {
  const result = await saveLockfileAssistantHost(
    assistant,
    assistant.assistantId,
  );
  if (result.ok) {
    lockfile = result.lockfile;
    setLocalSetting(LOCKFILE_STORAGE_KEY, JSON.stringify(result.lockfile));
  }
}

/**
 * Replace all platform-hosted assistant entries in the lockfile with the
 * current set from the API. Removes stale entries and adds new ones atomically.
 */
export async function syncPlatformAssistantsToLockfile(
  assistants: Array<{ id: string; is_local: boolean; created: string }>,
): Promise<void> {
  const platformAssistants = assistants
    .filter((a) => !a.is_local)
    .map((a) => ({
      assistantId: a.id,
      cloud: "vellum",
      runtimeUrl: window.location.origin,
      hatchedAt: a.created,
    }));

  const result = await replacePlatformAssistantsHost(platformAssistants);
  if (result.ok) {
    lockfile = result.lockfile;
    setLocalSetting(LOCKFILE_STORAGE_KEY, JSON.stringify(result.lockfile));
  }
}

// ---------------------------------------------------------------------------
// Retire
// ---------------------------------------------------------------------------

/**
 * Retire a local assistant, then clear its selection, gateway token, and
 * self-hosted connection and reload the lockfile. On failure the local state
 * is left untouched and the error is returned for the caller to surface.
 */
export async function retireLocalAssistant(
  assistantId: string,
): Promise<LocalRetireResult> {
  const result = await retireLocalAssistantHost(assistantId);
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

/**
 * Whether any assistant is known locally. Reads the in-memory lockfile cache,
 * so it stays synchronous on every host — no transport hop required.
 */
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
