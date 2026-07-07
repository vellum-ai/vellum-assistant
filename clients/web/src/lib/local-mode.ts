import { getLocalSetting, setLocalSetting } from "@/utils/local-settings";
import {
  clearSelectedAssistantId,
  readSelectedAssistantId,
} from "@/assistant/selected-assistant-storage";
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
const setCachedLockfile = (data: Lockfile, committed = true): void =>
  useLockfileStore.getState().setLockfile(data, committed);

const EMPTY_LOCKFILE: Lockfile = { assistants: [], activeAssistant: null };

const LOCKFILE_STORAGE_KEY = "vellum:local:lockfile";

export function getPlatformRuntimeUrl(): string {
  const injected = (
    window as unknown as {
      __VELLUM_CONFIG__?: { platformUrl?: string };
    }
  ).__VELLUM_CONFIG__;
  return injected?.platformUrl || window.location.origin;
}

function getInjectedConfig(): {
  disablePlatform?: boolean;
  mode?: string;
  platformUrl?: string;
} {
  return (
    (
      window as unknown as {
        __VELLUM_CONFIG__?: {
          disablePlatform?: boolean;
          mode?: string;
          platformUrl?: string;
        };
      }
    ).__VELLUM_CONFIG__ ?? {}
  );
}

export function isRemoteGatewayMode(): boolean {
  return getInjectedConfig().mode === "remote-gateway";
}

function getRemoteGatewayLockfile(): Lockfile {
  return {
    assistants: [
      {
        assistantId: "self",
        name: "Local Assistant",
        cloud: "local",
        runtimeUrl: window.location.origin,
        hatchedAt: "1970-01-01T00:00:00.000Z",
        resources: { gatewayPort: 0, daemonPort: 0 },
      },
    ],
    activeAssistant: "self",
  };
}

// Advance the in-memory cache and mirror the lockfile to persisted storage in
// one step. The mirror lets the synchronous `getLockfile()` hydrate from
// storage on a cold read before the host transport has responded.
const commitLockfile = (data: Lockfile): void => {
  setCachedLockfile(data);
  setLocalSetting(LOCKFILE_STORAGE_KEY, JSON.stringify(data));
  // Only reconcile against a lockfile from a successful host read/write — never
  // the transient empty fallback in `getLockfile`, which would wrongly drop a
  // valid selection on a boot/read failure.
  reconcileSelectedAssistant();
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
  const config = getInjectedConfig();
  if (config?.disablePlatform != null) return !!config.disablePlatform;

  const raw = import.meta.env.VITE_VELLUM_DISABLE_PLATFORM;
  if (raw) {
    const v = raw.toLowerCase();
    return v === "true" || v === "1";
  }

  return false;
}

export async function loadLockfile(): Promise<Lockfile> {
  if (isRemoteGatewayMode()) {
    const lockfile = getRemoteGatewayLockfile();
    commitLockfile(lockfile);
    return lockfile;
  }

  try {
    const data = await loadLockfileHost();
    commitLockfile(data);
    return data;
  } catch {
    // Host read failed — keep whatever we already have (the in-memory cache,
    // then the persisted mirror) rather than clobbering it with an empty
    // lockfile that subscribers would mistake for "no assistants".
    return getLockfile();
  }
}

export function getLockfile(): Lockfile {
  if (isRemoteGatewayMode()) {
    const lockfile = getRemoteGatewayLockfile();
    setCachedLockfile(lockfile);
    return lockfile;
  }

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

  // Not committed: this is a "nothing loaded yet" placeholder, not evidence
  // that the assistants are gone — reconciling subscribers must ignore it.
  const empty = { ...EMPTY_LOCKFILE };
  setCachedLockfile(empty, false);
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
export async function saveLockfileAssistant(assistant: {
  assistantId: string;
  name?: string;
  cloud: string;
  runtimeUrl: string;
  hatchedAt: string;
  organizationId?: string;
  platformAssistantId?: string;
  platformBaseUrl?: string;
  platformOrganizationId?: string;
}): Promise<void> {
  const result = await saveLockfileAssistantHost(
    assistant,
    assistant.assistantId,
  );
  if (result.ok) {
    commitLockfile(result.lockfile);
  }
}

/**
 * Update an existing assistant entry without changing the lockfile's active
 * assistant pointer.
 */
export async function updateLockfileAssistant(
  assistant: LockfileAssistant,
): Promise<void> {
  const result = await saveLockfileAssistantHost({ ...assistant }, undefined);
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
  if (isRemoteGatewayMode()) return;

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
  assistants: Array<{
    id: string;
    name?: string;
    is_local: boolean;
    created: string;
  }>,
  organizationId?: string,
  shouldApply: () => boolean = () => true,
): Promise<void> {
  // Without a resolved org we can't scope the replace; a full wipe here would
  // drop other orgs' platform entries. Skip — a later sync re-runs with the org.
  if (organizationId == null) return;
  // `shouldApply` lets a superseded caller (e.g. an out-of-date session probe)
  // back out before the host replace, and again before committing the result.
  if (!shouldApply()) return;

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

  const result = await replacePlatformAssistantsHost(
    platformAssistants,
    organizationId,
  );
  if (result.ok && shouldApply()) {
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
    // Clear the raw key directly (no store import here — that would cycle); the
    // reactive slice reconciles via the `loadLockfile` below → `setFromLockfile`.
    clearSelectedAssistantId();
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

/**
 * A local-kind assistant, by origin: a plain on-machine assistant the web client
 * drives through its local flows (gateway connect, wake, local retire) — cloud
 * `"local"`. (Legacy entries that predate the `cloud` field are normalized to
 * `"local"` at the parse seam, so `cloud` is always set by the time it reaches
 * here.) Identity only — whether it currently has a reachable gateway is a
 * separate, connect-time question (see `getLocalGatewayUrl`).
 *
 * Deliberately excludes the externally-managed container runtimes (`docker`,
 * `apple-container`) and remote self-hosted clouds (`paired`/`gcp`/`aws`/
 * `custom`, reached at their own `runtimeUrl`), along with platform (`vellum`):
 * the web client manages none of those through its local flows. See the
 * `KNOWN_CLOUDS` taxonomy in `@vellumai/local-mode/contract`.
 */
export function isLocalAssistant(a: LockfileAssistant): boolean {
  return a.cloud === "local";
}

export function isPlatformAssistant(a: LockfileAssistant): boolean {
  return a.cloud === "vellum";
}

/**
 * Whether `vellum wake` can start or repair the assistant with this id. Wake
 * operates only on plain local assistants (the {@link isLocalAssistant} set) —
 * it refuses Docker and apple-container entries — so the "Wake up" and
 * guardian-repair affordances are limited to them. A missing gateway port does
 * NOT disqualify: wake is what (re)establishes it.
 */
export function isCliWakeableAssistant(assistantId: string): boolean {
  const entry = getLockfile().assistants.find(
    (a) => a.assistantId === assistantId,
  );
  return !!entry && isLocalAssistant(entry);
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
  const selectedId = readSelectedAssistantId();
  if (selectedId) {
    const found = getLockfile().assistants.find(
      (a) => a.assistantId === selectedId,
    );
    if (found) return found;
  }
  return getActiveAssistant();
}

/** The lockfile entry for a specific assistant id, if one exists. */
export function getLockfileAssistant(
  assistantId: string,
): LockfileAssistant | undefined {
  return getLockfile().assistants.find((a) => a.assistantId === assistantId);
}

/**
 * Reconcile the selection key against the lockfile registry: if the selected id
 * no longer names a lockfile entry, clear it so `getSelectedAssistant` falls
 * back to `getActiveAssistant`. The store's own reconcile (on `setFromLockfile`)
 * covers the reactive slice; this keeps the raw key honest on the synchronous
 * `commitLockfile` path, including the pre-React-mount gateway-auth boot.
 */
export function reconcileSelectedAssistant(): void {
  const selectedId = readSelectedAssistantId();
  if (!selectedId) return;
  const present = getLockfile().assistants.some(
    (a) => a.assistantId === selectedId,
  );
  if (!present) clearSelectedAssistantId();
}

// ---------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------

export function gatewayProxyUrl(port: number): string {
  return `/assistant/__gateway/${port}`;
}

/**
 * Whether this runtime should reach `assistant` over a local gateway: a
 * local-kind assistant, in local (non-remote-gateway) mode. Whether that gateway
 * is currently resolvable — a recorded port — is a separate question answered by
 * `getLocalGatewayUrl`.
 */
function expectsLocalGateway(
  assistant: LockfileAssistant | undefined,
): assistant is LockfileAssistant {
  return (
    !!assistant &&
    isLocalMode() &&
    !isRemoteGatewayMode() &&
    isLocalAssistant(assistant)
  );
}

/**
 * Return the local gateway proxy URL for the given assistant (default: the
 * selected one), or `undefined` when this runtime doesn't reach it over a local
 * gateway or the gateway port hasn't been recorded yet.
 */
export function getLocalGatewayUrl(
  assistant: LockfileAssistant | undefined = getSelectedAssistant(),
): string | undefined {
  if (!expectsLocalGateway(assistant)) return undefined;
  const gatewayPort = assistant.resources?.gatewayPort;
  if (gatewayPort == null) return undefined;
  return gatewayProxyUrl(gatewayPort);
}

// ---------------------------------------------------------------------------
// Gateway connection setup
// ---------------------------------------------------------------------------

/**
 * A local assistant has no resolvable local gateway — e.g. a legacy/migrated
 * entry whose gateway port was never recorded. Recoverable by waking it (the
 * CLI/daemon establishes the daemon + gateway and records the port), so connect
 * flows treat it as a repairable connect error rather than a silent dead end.
 */
export class UnresolvedLocalGatewayError extends Error {
  constructor(assistantId: string) {
    super(`Local assistant ${assistantId} has no resolved gateway`);
    this.name = "UnresolvedLocalGatewayError";
  }
}

/**
 * Acquire a gateway token and prime the self-hosted connection for the given
 * local assistant (default: the selected one). The guardian token and gateway
 * exchange both ride the host's local-mode transport, so this stays
 * host-agnostic. Passing `target` lets connect flows prime the NEW assistant's
 * gateway before the selection write becomes observable, so the lifecycle's
 * selection subscription never publishes a connection with a token minted for
 * a different gateway.
 */
export async function primeLocalGatewayConnection(
  target?: LockfileAssistant,
): Promise<void> {
  const assistant = target ?? getSelectedAssistant();
  const tokenUrl = getLocalTokenUrl(assistant);
  if (!tokenUrl) {
    // A local assistant we recognize but can't resolve a gateway for (no port)
    // is recoverable by waking it — surface that instead of silently leaving
    // the session unconnected. Non-local / non-local-mode cases stay no-ops.
    if (expectsLocalGateway(assistant)) {
      throw new UnresolvedLocalGatewayError(assistant.assistantId);
    }
    return;
  }
  const guardianToken = assistant
    ? await fetchGuardianTokenHost(assistant.assistantId)
    : undefined;
  await ensureGatewayToken(tokenUrl, guardianToken);
  const localGateway = getLocalGatewayUrl(assistant);
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
export async function primeLocalGatewayConnectionWithRepair(
  target?: LockfileAssistant,
): Promise<void> {
  try {
    await primeLocalGatewayConnection(target);
    return;
  } catch (error) {
    if (!isRepairableConnectError(error)) throw error;
    const assistantId = (target ?? getSelectedAssistant())?.assistantId;
    if (!assistantId) throw error;
    const repair = await wakeLocalAssistantHost(assistantId);
    if (!repair.ok) throw error;
    // Wake may have established resources the renderer hadn't recorded (a legacy
    // entry's gateway port) — reload so the retry resolves the fresh gateway.
    const lockfile = await loadLockfile();
    const refreshed = lockfile.assistants.find(
      (a) => a.assistantId === assistantId,
    );
    await primeLocalGatewayConnection(refreshed ?? target);
  }
}
