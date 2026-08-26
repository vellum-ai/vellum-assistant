import {
  getLoopbackGatewayPort,
  isLoopbackGatewayCloud,
  isUsableRuntimeUrl,
} from "@vellumai/local-mode/contract";
import { isRetryablePairingReason } from "@vellumai/service-contracts/remote-web-pairing";

import { getLocalSetting, setLocalSetting } from "@/utils/local-settings";
import { isPublicBaseUrlRejection } from "@/utils/pairing-address";
import {
  clearSelectedAssistantId,
  readSelectedAssistantId,
} from "@/assistant/selected-assistant-storage";
import {
  clearGatewayToken,
  ensureGatewayToken,
  type EnsureGatewayTokenOptions,
  GatewayTokenError,
  getGatewayToken,
  getLocalTokenUrl,
} from "@/lib/auth/gateway-session";
import { getPlatformRuntimeUrl } from "@/lib/platform-runtime-url";
import {
  getSelfHostedIngressUrl,
  setSelfHostedConnection,
} from "@/lib/self-hosted/connection";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";
import { useLockfileStore } from "@/stores/lockfile-store";
import {
  fetchGuardianTokenHost,
  GuardianTokenError,
  isLocalModeHostAvailable,
  loadLockfileHost,
  pairingCancelHost,
  pairingPollHost,
  pairingStartHost,
  parseLockfile,
  replacePlatformAssistantsHost,
  retireLocalAssistantHost,
  renameLockfileAssistantHost,
  saveLockfileAssistantHost,
  unpairAssistantHost,
  wakeLocalAssistantHost,
} from "@/runtime/local-mode-host";
import type {
  Lockfile,
  LockfileAssistant,
  LocalAssistantResources,
  LocalPairingFailure,
  LocalPairingPollResult,
  LocalPairingStartResult,
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

export { getPlatformRuntimeUrl };

function getInjectedConfig(): {
  disablePlatform?: boolean;
  mode?: string;
  platformUrl?: string;
  assistantName?: string;
  hubUrl?: string;
} {
  return (
    (
      window as unknown as {
        __VELLUM_CONFIG__?: {
          disablePlatform?: boolean;
          mode?: string;
          platformUrl?: string;
          assistantName?: string;
          hubUrl?: string;
        };
      }
    ).__VELLUM_CONFIG__ ?? {}
  );
}

export function isRemoteGatewayMode(): boolean {
  return getInjectedConfig().mode === "remote-gateway";
}

function nonEmptyString(value: string | undefined): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/**
 * Display name of the serving assistant, when the served remote-gateway config
 * carries one. Older served configs omit it, so callers must tolerate
 * `undefined`.
 */
export function getRemoteGatewayAssistantName(): string | undefined {
  return nonEmptyString(getInjectedConfig().assistantName);
}

/** Live persona name when hydrated, else the (possibly stale) name the edge injected at tunnel start. */
export function getRemoteAssistantDisplayName(): string | undefined {
  const live = useAssistantIdentityStore.getState().name?.trim();
  return live || getRemoteGatewayAssistantName();
}

/**
 * The cloud hub SPA's assistant-root URL (`<origin>/assistant`), when the
 * served remote-gateway config carries one. Older served configs omit it, so
 * callers must tolerate `undefined`.
 */
export function getRemoteGatewayHubUrl(): string | undefined {
  return nonEmptyString(getInjectedConfig().hubUrl);
}

function getRemoteGatewayLockfile(): Lockfile {
  return {
    assistants: [
      {
        assistantId: "self",
        name: getRemoteGatewayAssistantName() ?? "Local Assistant",
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

export function isLocalClient(): boolean {
  const raw = import.meta.env.VITE_PLATFORM_MODE;
  if (!raw) {
    return true;
  }
  return !PLATFORM_MODE_TRUTHY.has(raw.toLowerCase());
}

export function isPlatformDisabled(): boolean {
  const config = getInjectedConfig();
  if (config?.disablePlatform != null) {
    return !!config.disablePlatform;
  }

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
  if (cached) {
    return cached;
  }

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
 * Record a managed (platform) assistant in the lockfile. The desktop build's
 * assistant list and switcher are lockfile-driven, so every managed hatch —
 * foreground hatching screen or headless background hatch — registers its
 * assistant here, stamped with the org whose session hatched it.
 *
 * The org id is a parameter because the organization store imports back through
 * the auth store into this module; reading it here would cycle.
 */
export async function saveManagedLockfileAssistant(
  assistantId: string,
  name: string | undefined,
  organizationId: string | undefined,
): Promise<void> {
  await saveLockfileAssistant({
    assistantId,
    name,
    cloud: "vellum",
    runtimeUrl: getPlatformRuntimeUrl(),
    hatchedAt: new Date().toISOString(),
    organizationId,
  });
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
 * Rename an existing assistant entry without touching its other fields or the
 * active assistant pointer. Runs through the host's rename-if-present
 * operation, which decides against the on-disk registry and refuses missing
 * entries and unreadable files instead of upserting, so a stale renderer
 * cache can never resurrect a retired assistant. The renderer-side guards
 * below are cheap early-outs, not the safety boundary.
 *
 * Resolves `true` when there is nothing left to do (converged, no-op guard,
 * or a successful write); `false` when the host write failed or refused, so
 * callers can retry.
 */
export async function renameLockfileAssistant(
  assistantId: string,
  name: string,
): Promise<boolean> {
  const trimmed = name.trim();
  if (!trimmed) {
    // Fresh assistants report "": never write an empty name.
    return true;
  }
  if (isRemoteGatewayMode() || !isLocalModeHostAvailable()) {
    return true;
  }
  const entry = getLockfileAssistant(assistantId);
  if (!entry || entry.name === trimmed) {
    // Rename-only: never create an entry, never write redundantly.
    return true;
  }
  const result = await renameLockfileAssistantHost(assistantId, trimmed);
  if (result.ok) {
    commitLockfile(result.lockfile);
    return true;
  }
  return false;
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
  if (isRemoteGatewayMode()) {
    return;
  }

  const entry = getLockfile().assistants.find(
    (a) => a.assistantId === assistantId,
  );
  if (!entry) {
    return;
  }
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
  if (organizationId == null) {
    return;
  }
  // `shouldApply` lets a superseded caller (e.g. an out-of-date session probe)
  // back out before the host replace, and again before committing the result.
  if (!shouldApply()) {
    return;
  }

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

/**
 * Remove a platform-hosted assistant's lockfile entry: a device-local
 * "forget" that never touches the assistant itself. Rides the platform-replace
 * host channel scoped to the entry's org: the remaining platform entries are
 * written back minus the target, so local entries and other orgs' platform
 * entries are untouched. A platform sync while logged in re-adds the
 * assistant, so this only affects what the device lists while logged out.
 */
export async function removePlatformAssistantFromLockfile(
  assistantId: string,
): Promise<{ ok: boolean; error?: string }> {
  const entry = getLockfileAssistant(assistantId);
  if (!entry || !isPlatformAssistant(entry)) {
    return { ok: false, error: "This assistant isn't in the local list." };
  }
  // Only the target org's entries ride the replace payload: the host treats
  // every supplied id as replaced-by-payload, and the renderer's parsed copies
  // drop host-only fields, so other orgs' on-disk records must stay out of the
  // payload to survive raw. A legacy org-less entry can't be scoped; its
  // unscoped replace resends every platform entry (minus the target).
  const remaining = getPlatformAssistants()
    .filter((a) => a.assistantId !== assistantId)
    .filter(
      (a) =>
        entry.organizationId == null ||
        a.organizationId === entry.organizationId,
    )
    .map((a) => ({ ...a }));
  const result = await replacePlatformAssistantsHost(
    remaining,
    entry.organizationId,
  );
  if (!result.ok) {
    return { ok: false, error: result.error || "Failed to remove assistant." };
  }
  commitLockfile(result.lockfile);
  return { ok: true };
}

/**
 * Drop the session state bound to the selected assistant: the raw selection
 * key (no store import here, that would cycle; the reactive slice reconciles
 * via `setFromLockfile` on the next lockfile commit/load), the gateway token,
 * and the self-hosted connection.
 */
function clearSelectedAssistantSession(): void {
  clearSelectedAssistantId();
  clearGatewayToken();
  setSelfHostedConnection(null);
}

/**
 * Forget a paired assistant on this device: the host removes its lockfile
 * entry and deletes its stored guardian token, never touching the remote
 * assistant (pair again anytime with `vellum connect import`). When the
 * removed entry is the effective selection, the session residue (selection
 * key, gateway token, self-hosted connection) is cleared the same way a
 * local retire clears it, so the next connect starts clean.
 */
export async function removePairedAssistantFromLockfile(
  assistantId: string,
): Promise<{ ok: boolean; error?: string }> {
  const entry = getLockfileAssistant(assistantId);
  if (!entry) {
    return { ok: false, error: "This assistant isn't in the local list." };
  }
  if (!isPairedAssistant(entry)) {
    return { ok: false, error: "This assistant isn't paired on this device." };
  }
  const wasSelected = getSelectedAssistant()?.assistantId === assistantId;
  const result = await unpairAssistantHost(assistantId);
  if (!result.ok) {
    return { ok: false, error: result.error || "Failed to remove assistant." };
  }
  if (wasSelected) {
    clearSelectedAssistantSession();
  }
  commitLockfile(result.lockfile);
  return { ok: true };
}

/** Stands in when a host reports a failure with no message of its own. */
const PAIRING_FALLBACK_ERROR = "Failed to connect to that assistant.";

/**
 * Whether a refused pairing step is worth polling through, classified by the
 * shared reason table so the dialog and `vellum connect import` cannot drift.
 */
export function isRetryablePairingFailure(
  failure: LocalPairingFailure,
): boolean {
  return isRetryablePairingReason(failure.reason);
}

/**
 * Begin pairing with the assistant at `address`, a pairing link or a bare
 * `https://host` URL. The host runs the exchange and keeps the device code,
 * so what comes back is an opaque handle plus, when the address carried no
 * approved code, the code to approve on the assistant's machine.
 */
export async function startAssistantPairing(
  address: string,
): Promise<LocalPairingStartResult> {
  const result = await pairingStartHost(address);
  if (!result.ok) {
    return {
      ...result,
      error: result.error || PAIRING_FALLBACK_ERROR,
      // Runtime guard, as on the poll below: the dev-server host branch parses
      // untyped JSON, so a reason no caller has copy for degrades to the
      // host's own message rather than to no message at all.
      rejection: isPublicBaseUrlRejection(result.rejection)
        ? result.rejection
        : undefined,
    };
  }
  return result;
}

/**
 * One exchange attempt for a live pairing session. On `imported` the lockfile
 * is reloaded so subscribers (the resolved-assistants store) pick up the new
 * entry, the write counterpart of {@link removePairedAssistantFromLockfile}.
 * `accessOnly` is true when the exchange yielded no refresh credential, so the
 * pairing's access expires and cannot renew itself.
 */
export async function pollAssistantPairing(
  handle: string,
  name?: string,
): Promise<LocalPairingPollResult> {
  const result = await pairingPollHost(handle, name);
  if (!result.ok) {
    return { ...result, error: result.error || PAIRING_FALLBACK_ERROR };
  }
  if (result.status === "pending") {
    return result;
  }
  // Runtime guard: the dev-server host branch parses untyped JSON, so a
  // malformed success degrades to a structured failure.
  if (!result.assistantId) {
    return { ok: false, error: PAIRING_FALLBACK_ERROR };
  }
  await loadLockfile();
  return { ...result, accessOnly: result.accessOnly === true };
}

/**
 * Forget a pending pairing session, so its code cannot be exchanged later.
 * Callers cancel on the way out (a dismissed dialog, a dead transport) and
 * have nothing to do about a failure, and a handle the host no longer knows
 * is already the outcome they wanted, so a rejecting host resolves quietly.
 */
export async function cancelAssistantPairing(handle: string): Promise<void> {
  try {
    await pairingCancelHost(handle);
  } catch {
    // Unreachable session: cancelled, spent, or the host itself is gone.
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
    clearSelectedAssistantSession();
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
 * drives through its full set of local lifecycle flows (wake, local retire) —
 * cloud `"local"`. (Legacy entries that predate the `cloud` field are normalized
 * to `"local"` at the parse seam, so `cloud` is always set by the time it
 * reaches here.) Identity only — whether it currently has a reachable gateway is
 * a separate, connect-time question (see `getLocalGatewayUrl`).
 *
 * Deliberately excludes the externally-managed container runtimes (`docker`,
 * `apple-container`) and remote self-hosted clouds (`paired`/`gcp`/`aws`/
 * `custom`, reached at their own `runtimeUrl`), along with platform (`vellum`):
 * the web client manages none of those through its lifecycle flows. Docker
 * instances ARE still reachable over the local gateway proxy — that broader,
 * connect-only set is {@link isLocalGatewayAssistant}. See the `KNOWN_CLOUDS`
 * taxonomy in `@vellumai/local-mode/contract`.
 */
export function isLocalAssistant(a: LockfileAssistant): boolean {
  return a.cloud === "local";
}

/**
 * An assistant this runtime connects to over the local gateway proxy
 * (`/assistant/__gateway/<port>`) with gateway auth: a plain on-machine
 * assistant (`local`) or a local Docker instance (`docker`). Both run their
 * gateway on a loopback port of this machine and lease guardian tokens under
 * the CLI config dir, so the SPA can mint a gateway token for them without a
 * platform session.
 *
 * Connect-only — a superset of {@link isLocalAssistant} that does NOT extend to
 * the lifecycle flows (wake, local retire), which stay `cloud === "local"`.
 * Excludes `apple-container` (its entries are managed by the macOS app and
 * record no renderer-resolvable loopback gateway), the remote self-hosted
 * clouds, and platform (`vellum`).
 */
export function isLocalGatewayAssistant(a: LockfileAssistant): boolean {
  return isLoopbackGatewayCloud(a.cloud);
}

export function isPlatformAssistant(a: LockfileAssistant): boolean {
  return a.cloud === "vellum";
}

/**
 * A remote assistant paired from another machine via `vellum connect import`
 * (`cloud === "paired"`): reached directly at its own `runtimeUrl` with the
 * stored guardian access token as the bearer. Not local (no lifecycle flows,
 * wake/retire refuse it) and not platform (no platform session involved).
 * See the `KNOWN_CLOUDS` taxonomy in `@vellumai/local-mode/contract`.
 */
export function isPairedAssistant(a: { cloud?: string }): boolean {
  return a.cloud === "paired";
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
  if (active) {
    return active;
  }
  if (lf.assistants.length === 1) {
    return lf.assistants[0];
  }
  return undefined;
}

export function getSelectedAssistant(): LockfileAssistant | undefined {
  const selectedId = readSelectedAssistantId();
  if (selectedId) {
    const found = getLockfile().assistants.find(
      (a) => a.assistantId === selectedId,
    );
    if (found) {
      return found;
    }
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
 * React subscription to one lockfile entry's `name`: `undefined` while the
 * lockfile hasn't hydrated or the id has no entry, `null` when the entry
 * exists but is unnamed. Distinguishing absence from an unnamed entry lets
 * effects depending on this value re-fire even when the appearing entry
 * carries no name.
 */
export function useLockfileAssistantName(
  assistantId: string | null,
): string | null | undefined {
  return useLockfileStore((s) => {
    if (assistantId === null) {
      return undefined;
    }
    const entry = s.lockfile?.assistants.find(
      (a) => a.assistantId === assistantId,
    );
    return entry === undefined ? undefined : (entry.name ?? null);
  });
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
  if (!selectedId) {
    return;
  }
  const present = getLockfile().assistants.some(
    (a) => a.assistantId === selectedId,
  );
  if (!present) {
    clearSelectedAssistantId();
  }
}

// ---------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------

export function gatewayProxyUrl(port: number): string {
  return `/assistant/__gateway/${port}`;
}

/**
 * Whether this runtime should reach `assistant` over a local gateway: a
 * local-gateway assistant ({@link isLocalGatewayAssistant}), in local
 * (non-remote-gateway) mode. Whether that gateway is currently resolvable — a
 * recorded port — is a separate question answered by `getLocalGatewayUrl`.
 */
function expectsLocalGateway(
  assistant: LockfileAssistant | undefined,
): assistant is LockfileAssistant {
  return (
    !!assistant &&
    isLocalClient() &&
    !isRemoteGatewayMode() &&
    isLocalGatewayAssistant(assistant)
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
  if (!expectsLocalGateway(assistant)) {
    return undefined;
  }
  const gatewayPort = getLoopbackGatewayPort(assistant);
  if (gatewayPort == null) {
    return undefined;
  }
  return gatewayProxyUrl(gatewayPort);
}

/**
 * Whether this runtime should reach `assistant` at a remote paired gateway: a
 * paired entry ({@link isPairedAssistant}), in local (non-remote-gateway) mode.
 * Whether the entry records a usable `runtimeUrl` is a separate question
 * answered by `getPairedGatewayUrl`. Deliberately not a type predicate: its
 * false branch must not narrow `assistant` (a local entry also lands there).
 */
function expectsPairedGateway(assistant: LockfileAssistant): boolean {
  return (
    isLocalClient() && !isRemoteGatewayMode() && isPairedAssistant(assistant)
  );
}

/** Same-origin proxy path for a paired assistant's remote gateway. */
function pairedGatewayProxyUrl(assistantId: string): string {
  return `/assistant/__gateway-paired/${encodeURIComponent(assistantId)}`;
}

/**
 * The same-origin proxy path this runtime reaches a paired assistant's remote
 * gateway through, or `undefined` when the entry isn't paired, isn't usable in
 * this runtime (non-local client or remote-gateway mode), or records no
 * absolute http(s) `runtimeUrl` for the host to forward to.
 *
 * The renderer never fetches the remote origin directly: the packaged app's
 * CSP pins `connect-src` to Vellum origins, and a browser-served SPA would be
 * stopped by the remote gateway's CORS. Instead the serving host (the Electron
 * `app://` handler, the Vite dev middleware, the CLI web server) resolves the
 * entry's recorded `runtimeUrl` and forwards, exactly like the loopback
 * `__gateway/{port}` data-plane proxy.
 */
export function getPairedGatewayUrl(
  assistant: LockfileAssistant | undefined,
): string | undefined {
  if (!assistant || !expectsPairedGateway(assistant)) {
    return undefined;
  }
  if (!isUsableRuntimeUrl(assistant.runtimeUrl)) {
    return undefined;
  }
  return pairedGatewayProxyUrl(assistant.assistantId);
}

/**
 * Absolute base URL this runtime reaches the given assistant's gateway at:
 * origin + local gateway proxy for local/docker entries, origin + paired
 * gateway proxy for paired entries, `undefined` otherwise.
 */
export function getAuthGatewayIngressUrl(
  assistant: LockfileAssistant | undefined,
): string | undefined {
  const base = getLocalGatewayUrl(assistant) ?? getPairedGatewayUrl(assistant);
  if (!base) {
    return undefined;
  }
  return `${window.location.origin}${base}`;
}

/**
 * One-shot probe of the local gateway's `/readyz` (which reports gateway AND
 * upstream daemon readiness). True only when the gateway answers with an ok
 * body that does not report `ready: false`; false when the gateway URL is
 * unresolvable, the request fails, or the gateway is up but not yet ready.
 */
function isReadyzResponseReady(body: unknown): boolean {
  if (body === null || typeof body !== "object") {
    return false;
  }
  const readiness = body as { status?: unknown; ready?: unknown };
  return (
    readiness.status === "ok" &&
    (readiness.ready === undefined || readiness.ready === true)
  );
}

export async function probeLocalGatewayReady(): Promise<boolean> {
  const gatewayUrl = getLocalGatewayUrl();
  if (!gatewayUrl) {
    return false;
  }
  try {
    const res = await fetch(`${gatewayUrl}/readyz`);
    if (!res.ok) {
      return false;
    }
    const body: unknown = await res.json();
    return isReadyzResponseReady(body);
  } catch {
    return false;
  }
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
 * A paired assistant records no usable `runtimeUrl`, so there is no remote
 * gateway to reach. Deliberately not {@link UnresolvedLocalGatewayError}: that
 * one routes to the wake-recovery dialog in the chooser, and `wake` refuses
 * paired entries (re-pairing from the source machine is the fix).
 */
export class UnresolvedPairedGatewayError extends Error {
  constructor(assistantId: string) {
    super(`Paired assistant ${assistantId} has no usable runtimeUrl`);
    this.name = "UnresolvedPairedGatewayError";
  }
}

/**
 * Prime the self-hosted connection for the given local or paired assistant
 * (default: the selected one). Local assistants mint a renderer actor token;
 * paired assistants use a same-origin proxy whose trusted host injects its
 * guardian bearer. Passing `target` lets connect flows prime the new
 * assistant before the selection write becomes observable.
 *
 * `options.forceMint` re-mints a local assistant's renderer token even when
 * the cache holds an unexpired one, for callers recovering from the gateway
 * rejecting that token. Paired assistants mint no renderer token, so the
 * option is a no-op for them.
 */
export type PrimeLocalGatewayConnectionOptions = Pick<
  EnsureGatewayTokenOptions,
  "forceMint"
>;

export async function primeLocalGatewayConnection(
  target?: LockfileAssistant,
  options: PrimeLocalGatewayConnectionOptions = {},
): Promise<void> {
  const assistant = target ?? getSelectedAssistant();
  if (assistant && expectsPairedGateway(assistant)) {
    const pairedUrl = getPairedGatewayUrl(assistant);
    if (!pairedUrl) {
      throw new UnresolvedPairedGatewayError(assistant.assistantId);
    }
    const ingressUrl = getAuthGatewayIngressUrl(assistant)!;
    // A request through the paired proxy forces the trusted host to resolve
    // the credential and proves the remote gateway is reachable. The renderer
    // sends no bearer. A connection to this same paired gateway stays live
    // while the probe is in flight (a re-prime must not open a window in
    // which requests fall through to the platform and gateway-auth predicates
    // read false) and is dropped only if the probe fails, so a failed prime
    // never leaves the app believing it is connected. A slot pointing at some
    // other assistant is left alone either way. It also clears credentials
    // persisted by older clients that placed paired guardian tokens in the
    // gateway-session cache.
    try {
      const response = await fetch(`${pairedUrl}/readyz`);
      if (!response.ok) {
        const message = await response.text();
        throw new GuardianTokenError(
          response.status,
          message || `Paired gateway request failed: ${response.status}`,
        );
      }
      const readiness: unknown = await response.json().catch(() => null);
      if (!isReadyzResponseReady(readiness)) {
        throw new Error("Paired assistant is not ready");
      }
    } catch (error) {
      if (getSelfHostedIngressUrl() === ingressUrl) {
        setSelfHostedConnection(null);
      }
      throw error;
    }
    clearGatewayToken();
    setSelfHostedConnection({
      url: ingressUrl,
      token: null,
    });
    return;
  }
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
  await ensureGatewayToken(tokenUrl, guardianToken, {
    forceMint: options.forceMint,
  });
  const ingressUrl = getAuthGatewayIngressUrl(assistant);
  if (!ingressUrl) {
    return;
  }
  setSelfHostedConnection({
    url: ingressUrl,
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
  if (error instanceof GuardianTokenError) {
    return error.status !== 403;
  }
  return true;
}

/**
 * Retry budget for riding out the local gateway's startup window. On reboot the
 * gateway (a macOS Login Item) restarts concurrently with the desktop app, and
 * a `wake` restarts it in place — in both cases the loopback `/auth/token` mint
 * refuses connections or answers transiently (a `503` "starting", or a
 * repairable `401` before the guardian binding backfill lands) for the first
 * few seconds. A single prime races that window and dead-ends to the recovery
 * controls even though the gateway becomes usable moments later. Mutable so
 * tests can shrink the window.
 */
export const LOCAL_GATEWAY_STARTUP_RETRY = {
  attempts: 8,
  intervalMs: 1_000,
};

/**
 * A gateway that is UP but transiently rejecting the mint as it finishes
 * starting after a reboot: a `503` "starting" (or another `5xx`) before its
 * post-assistant-ready work completes, or a repairable `401` in the window
 * after traffic opens but before the guardian-binding backfill lands — the
 * reported reboot symptom. Both heal on their own within seconds, so the boot
 * restore rides them out (never `wake`ing).
 *
 * A `403` loopback-boundary refusal is terminal. A thrown transport error is
 * deliberately excluded: the gateway isn't answering at all (an intentionally
 * stopped assistant, not a starting one), so the boot restore falls through to
 * the chooser promptly instead of stalling the whole retry budget on an
 * assistant the user isn't running — the chooser's connect-with-repair path
 * (which may `wake`) handles that case.
 */
function isGatewayStillStarting(error: unknown): boolean {
  return error instanceof GatewayTokenError && error.status !== 403;
}

/**
 * A `wake`-restarted gateway that hasn't finished coming back up: it refuses
 * connections (a thrown transport error), answers `503`/`5xx`, or rejects the
 * mint with a repairable `401` while it re-provisions its guardian binding.
 * A guardian refresh `5xx` is the same window: the host shells out to
 * `vellum gateway token refresh`, which cannot reach a gateway that is still
 * binding its port. A `403` loopback-boundary refusal is terminal, and a
 * missing (`404`) or rejected (`401`) guardian token will not heal by
 * waiting (the just-run `wake` already re-seeded the token and recorded the
 * port), so those fall through.
 */
function isGatewayRestartTransient(error: unknown): boolean {
  if (error instanceof GuardianTokenError) {
    return error.status >= 500;
  }
  if (error instanceof UnresolvedLocalGatewayError) {
    return false;
  }
  if (error instanceof GatewayTokenError) {
    return error.status !== 403;
  }
  // A thrown fetch/transport error — the gateway isn't accepting connections
  // yet as it restarts.
  return true;
}

/**
 * Prime the local gateway connection, retrying on a bounded interval while the
 * failure is a transient startup condition (`shouldRideOut`). Rides out the
 * local gateway's startup window without spawning anything — the plain prime
 * only reads the on-disk guardian token and mints a gateway session — so it
 * respects the "app launch never spawns daemon processes" boot contract. The
 * last error propagates once the retry budget is spent or the failure is not a
 * ride-out-able one, so the existing connect-error classification is preserved.
 */
async function primeLocalGatewayWithStartupRideout(
  target: LockfileAssistant | undefined,
  shouldRideOut: (error: unknown) => boolean,
  options: PrimeLocalGatewayConnectionOptions = {},
): Promise<void> {
  const { attempts, intervalMs } = LOCAL_GATEWAY_STARTUP_RETRY;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await primeLocalGatewayConnection(target, options);
      return;
    } catch (error) {
      if (attempt >= attempts || !shouldRideOut(error)) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
}

/**
 * Boot restore path: prime the selected local assistant's gateway connection,
 * riding out the gateway's startup window when it is up but still starting
 * ({@link isGatewayStillStarting}). Unlike the interactive
 * {@link primeLocalGatewayConnectionWithRepair}, this never `wake`s — app launch
 * must not spawn daemon processes — so a gateway that is down entirely, or one
 * that rejects the mint (a repairable `401`), falls through promptly to the
 * chooser, where the auto-connect flow's repair handles it.
 */
export async function primeLocalGatewayConnectionWithStartupRetry(
  target?: LockfileAssistant,
): Promise<void> {
  await primeLocalGatewayWithStartupRideout(target, isGatewayStillStarting);
}

/**
 * Prime the local gateway connection, transparently repairing the assistant in
 * place when the first attempt fails for a repairable reason.
 *
 * This mirrors the native client's bootstrap, which revives a stopped or
 * unresolved local assistant before the failure ever reaches the user: on a
 * repairable failure it runs a plain `wake` (restarts the daemon + gateway,
 * leaving the assistant's data and identity untouched), then primes the
 * connection once more. A non-repairable failure, a wake that itself fails, or
 * a still-failing retry propagate the original error so the existing
 * connect-error UI surfaces it unchanged.
 *
 * A plain wake cannot re-lease a guardian token the gateway rejects at the
 * `/auth/token` mint, so a `401` that survives the retry propagates as a
 * {@link GatewayTokenError} for callers to route to the guardian re-provision
 * (`wakeLocalAssistantHost` with `repairGuardian`), the one repair that clears
 * it and the one this path must never run on its own.
 */
export async function primeLocalGatewayConnectionWithRepair(
  target?: LockfileAssistant,
  options: PrimeLocalGatewayConnectionOptions = {},
): Promise<void> {
  const assistant = target ?? getSelectedAssistant();
  try {
    await primeLocalGatewayConnection(assistant, options);
    return;
  } catch (error) {
    // Wake operates only on plain local assistants (see
    // `isCliWakeableAssistant`): spawning it for a paired or otherwise
    // non-local target would burn time on a refusal, so their failures
    // propagate untouched.
    if (!assistant || !isLocalAssistant(assistant)) {
      throw error;
    }
    if (!isRepairableConnectError(error)) {
      throw error;
    }
    const assistantId = assistant.assistantId;
    const repair = await wakeLocalAssistantHost(assistantId);
    if (!repair.ok) {
      throw error;
    }
    // Wake may have established resources the renderer hadn't recorded (a legacy
    // entry's gateway port) — reload so the retry resolves the fresh gateway.
    const lockfile = await loadLockfile();
    const refreshed = lockfile.assistants.find(
      (a) => a.assistantId === assistantId,
    );
    // Wake restarts the daemon + gateway, so the retry races the gateway coming
    // back up — a single prime here fails while it is still starting and the
    // connect dead-ends to the recovery controls. Ride out that restart window
    // instead, so a persisted local assistant reconnects on its own.
    await primeLocalGatewayWithStartupRideout(
      refreshed ?? assistant,
      isGatewayRestartTransient,
      options,
    );
  }
}
