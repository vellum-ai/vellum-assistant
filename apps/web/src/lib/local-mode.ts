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
import { useLockfileStore } from "@/stores/lockfile-store";
import {
  fetchGuardianTokenHost,
  GuardianTokenError,
  loadLockfileHost,
  parseLockfile,
  replacePlatformAssistantsHost,
  retireLocalAssistantHost,
  saveLockfileAssistantHost,
  wakeLocalAssistantHost,
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
// Cache
// ---------------------------------------------------------------------------

// The cache lives in the lockfile store so React consumers can subscribe to
// changes; this module owns the transport and is the only writer.
const getCachedLockfile = (): Lockfile | null =>
  useLockfileStore.getState().lockfile;
const setCachedLockfile = (data: Lockfile): void =>
  useLockfileStore.getState().setLockfile(data);

const EMPTY_LOCKFILE: Lockfile = { assistants: [], activeAssistant: null };

const LOCKFILE_STORAGE_KEY = "vellum:local:lockfile";
const SELECTED_ASSISTANT_STORAGE_KEY = "vellum:local:selectedAssistantId";

export function getPlatformRuntimeUrl(): string {
  const injected = (
    window as unknown as {
      __VELLUM_CONFIG__?: { platformUrl?: string };
    }
  ).__VELLUM_CONFIG__;
  return injected?.platformUrl || window.location.origin;
}

// Advance the in-memory cache and mirror the lockfile to persisted storage in
// one step. The mirror lets the synchronous `getLockfile()` hydrate from
// storage on a cold read before the host transport has responded.
const commitLockfile = (data: Lockfile): void => {
  setCachedLockfile(data);
  setLocalSetting(LOCKFILE_STORAGE_KEY, JSON.stringify(data));
};

// ---------------------------------------------------------------------------
// Core helpers
// ---------------------------------------------------------------------------

const PLATFORM_MODE_TRUTHY = new Set(["1", "true", "yes"]);

export function isLocalMode(): boolean {
  const raw = import.meta.env.VITE_PLATFORM_MODE;
  if (!raw) return true;
  return !PLATFORM_MODE_TRUTHY.has(raw.toLowerCase());
}

export function isPlatformDisabled(): boolean {
  const config = (
    window as unknown as {
      __VELLUM_CONFIG__?: { disablePlatform?: boolean };
    }
  ).__VELLUM_CONFIG__;
  if (config?.disablePlatform != null) return !!config.disablePlatform;

  const raw = import.meta.env.VITE_VELLUM_DISABLE_PLATFORM;
  if (raw) {
    const v = raw.toLowerCase();
    return v === "true" || v === "1";
  }

  return false;
}

export async function loadLockfile(): Promise<Lockfile> {
  try {
    const data = await loadLockfileHost();
    commitLockfile(data);
    return data;
  } catch {
    const empty = { ...EMPTY_LOCKFILE };
    setCachedLockfile(empty);
    return empty;
  }
}

export function getLockfile(): Lockfile {
  const cached = getCachedLockfile();
  if (cached) return cached;

  const stored = getLocalSetting(LOCKFILE_STORAGE_KEY, "");
  if (stored) {
    try {
      const parsed = parseLockfile(JSON.parse(stored));
      setCachedLockfile(parsed);
      return parsed;
    } catch {
      // Unparseable JSON -- fall through to empty lockfile. (A structurally
      // invalid lockfile does not throw: parseLockfile salvages what it can.)
    }
  }

  const empty = { ...EMPTY_LOCKFILE };
  setCachedLockfile(empty);
  return empty;
}

// ---------------------------------------------------------------------------
// Lockfile mutation
// ---------------------------------------------------------------------------

/**
 * Write an assistant entry to the lockfile on disk and refresh the cache,
 * making it the active assistant. Silently no-ops on a write failure: the
 * cache only advances once the on-disk write succeeds.
 */
export async function saveLockfileAssistant(
  assistant: { assistantId: string; name?: string; cloud: string; runtimeUrl: string; hatchedAt: string; organizationId?: string },
): Promise<void> {
  const result = await saveLockfileAssistantHost(
    assistant,
    assistant.assistantId,
  );
  if (result.ok) {
    commitLockfile(result.lockfile);
  }
}

/**
 * Mark an already-known assistant as the lockfile's active assistant, leaving
 * its other fields untouched. Used when switching managed assistants so the
 * lockfile `activeAssistant` — read by the macOS tray, the CLI, and the native
 * client — tracks the in-app selection. No-ops in the browser (no lockfile
 * host) and when the id isn't a known entry.
 */
export async function setActiveLockfileAssistant(
  assistantId: string,
): Promise<void> {
  const entry = getLockfile().assistants.find(
    (a) => a.assistantId === assistantId,
  );
  if (!entry) return;
  const result = await saveLockfileAssistantHost({ ...entry }, assistantId);
  if (result.ok) {
    commitLockfile(result.lockfile);
  }
}

/**
 * Replace all platform-hosted assistant entries in the lockfile with the
 * current set from the API. Removes stale entries and adds new ones atomically.
 *
 * `organizationId` is stamped onto every platform entry so the host proxy can
 * scope requests without guessing. The caller passes the active org: the API
 * list is org-scoped by the `Vellum-Organization-Id` header, so every assistant
 * in `assistants` belongs to that org.
 */
export async function syncPlatformAssistantsToLockfile(
  assistants: Array<{ id: string; name?: string; is_local: boolean; created: string }>,
  organizationId?: string,
): Promise<void> {
  const platformAssistants = assistants
    .filter((a) => !a.is_local)
    .map((a) => ({
      assistantId: a.id,
      ...(a.name != null && { name: a.name }),
      cloud: "vellum",
      runtimeUrl: getPlatformRuntimeUrl(),
      hatchedAt: a.created,
      ...(organizationId != null && { organizationId }),
    }));

  const result = await replacePlatformAssistantsHost(platformAssistants);
  if (result.ok) {
    commitLockfile(result.lockfile);
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

export function isPlatformAssistant(a: LockfileAssistant): boolean {
  return a.cloud === "vellum";
}

export function getLocalAssistants(): LockfileAssistant[] {
  return getLockfile().assistants.filter(isLocalAssistant);
}

export function getPlatformAssistants(): LockfileAssistant[] {
  return getLockfile().assistants.filter(isPlatformAssistant);
}

/**
 * The lockfile's active assistant, or — when the recorded `activeAssistant`
 * no longer resolves but exactly one assistant exists — that sole assistant.
 * Returns `undefined` when the active id is stale and the choice is ambiguous,
 * so callers fall back deliberately rather than silently binding to a
 * positional entry that may shadow the real active assistant.
 */
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
// Gateway connection setup
// ---------------------------------------------------------------------------

/**
 * Acquire a gateway token and prime the self-hosted connection for the
 * selected local assistant. The guardian token and gateway exchange both ride
 * the host's local-mode transport, so this stays host-agnostic.
 */
export async function primeLocalGatewayConnection(): Promise<void> {
  const tokenUrl = getLocalTokenUrl();
  if (!tokenUrl) return;
  const assistant = getSelectedAssistant();
  const guardianToken = assistant
    ? await fetchGuardianTokenHost(assistant.assistantId)
    : undefined;
  await ensureGatewayToken(tokenUrl, guardianToken);
  const localGateway = getLocalGatewayUrl();
  if (!localGateway) return;
  setSelfHostedConnection({
    url: `${window.location.origin}${localGateway}`,
    token: getGatewayToken(),
  });
}

/**
 * Classify a connect failure as repairable by `wake`. A `403` means the host
 * refused the loopback boundary — a security decision wake can't change — so
 * it surfaces as-is. Every other failure (a missing/expired/malformed guardian
 * token, or an unreachable or stopped gateway) is something `wake` can fix by
 * re-seeding the token and restarting the daemon + gateway.
 */
function isRepairableConnectError(error: unknown): boolean {
  if (error instanceof GuardianTokenError) return error.status !== 403;
  return true;
}

/**
 * Prime the local gateway connection, transparently repairing the assistant in
 * place when the first attempt fails for a repairable reason.
 *
 * This mirrors the native client's bootstrap, which re-pairs a stopped,
 * expired, or mis-seeded local assistant before the failure ever reaches the
 * user: on a repairable failure it runs `wake` (re-seeds the guardian token
 * and restarts the daemon + gateway, leaving the assistant's data and identity
 * untouched), then primes the connection once more. A non-repairable failure,
 * a wake that itself fails, or a still-failing retry propagate the original
 * error so the existing connect-error UI surfaces it unchanged.
 */
export async function primeLocalGatewayConnectionWithRepair(): Promise<void> {
  try {
    await primeLocalGatewayConnection();
    return;
  } catch (error) {
    if (!isRepairableConnectError(error)) throw error;
    const assistantId = getSelectedAssistant()?.assistantId;
    if (!assistantId) throw error;
    const repair = await wakeLocalAssistantHost(assistantId);
    if (!repair.ok) throw error;
    await primeLocalGatewayConnection();
  }
}
