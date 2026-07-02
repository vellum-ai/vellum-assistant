import type {
  LocalAssistantStatusResult,
  LocalUpgradeOptions,
  LocalWakeOptions,
} from "@vellumai/ipc-contract";
import { parseLockfile } from "@vellumai/local-mode/contract";
import type {
  Lockfile,
  LockfileAssistant,
  LocalAssistantResources,
  LockfileWriteResult,
} from "@vellumai/local-mode/contract";

import { isElectron } from "@/runtime/is-electron";

/**
 * Transport seam for local-mode lifecycle operations (hatch, retire, lockfile
 * reads/writes, and guardian-token acquisition).
 *
 * Local mode provisions an assistant on the user's own machine by driving the
 * Vellum CLI and reading/writing its lockfile. That work runs in a trusted
 * host process, never the renderer: in the Electron desktop shell it runs in
 * the main process behind `window.vellum.localMode.*`; on the web/dev host it
 * runs in the Vite dev server behind `/assistant/__local/*` middleware. This
 * module is the single place that branch lives — feature code imports these
 * named functions and stays host-agnostic, mirroring the per-capability
 * `runtime/` wrapper rule in `clients/web/docs/ELECTRON.md`.
 *
 * Both branches return the same wire contract, so callers never observe which
 * host they're on. The contract types are owned by `@vellumai/local-mode` —
 * the package every host produces them from — and re-exported here so `lib/`
 * can keep importing them from `runtime/` without reaching back into `lib/`.
 *
 * Unlike the host-only wrappers (`dock.ts`, `native-biometric.ts`), these
 * functions are NOT no-ops off Electron — the web/dev branch is a real
 * implementation, because local mode is a first-class web/dev capability, not
 * a desktop-only nicety.
 *
 * The gateway *data plane* deliberately has no seam function: callers fetch
 * the same-origin `/assistant/__gateway/{port}/*` URL on both hosts, and each
 * host proxies it to the local gateway transparently (the Vite dev middleware
 * on web/dev; the Electron `app://` protocol handler in the desktop shell).
 * The transport branch lives in the host, not the renderer, so the data-plane
 * URL stays byte-identical everywhere.
 */

export type {
  Lockfile,
  LockfileAssistant,
  LocalAssistantResources,
  LockfileWriteResult,
};

// The contract's validating parser, re-exported so `lib/` can run persisted
// (localStorage) lockfile reads through the same total validation the hosts
// apply to on-disk reads, without importing the package directly.
export { parseLockfile };

export interface LocalHatchResult {
  ok: boolean;
  assistantId?: string;
  error?: string;
}

export interface LocalRetireResult {
  ok: boolean;
  error?: string;
}

export interface LocalSleepResult {
  ok: boolean;
  error?: string;
}

export interface LocalWakeResult {
  ok: boolean;
  error?: string;
}

export interface LocalUpgradeResult {
  ok: boolean;
  version?: string;
  error?: string;
}

export type { LocalAssistantStatusResult };
export type { LocalUpgradeOptions };

/**
 * Thrown by {@link fetchGuardianTokenHost} when a host returns a structured
 * guardian-token failure. Carries the host's `status` so callers can branch on
 * the failure class — a missing (`404`) or expired (`401`) token means the
 * assistant must be re-provisioned (hatch/wake), whereas a `403`/`5xx`/network
 * failure is transient and worth retrying — instead of string-matching the
 * message. Both hosts already produce the status (the package's
 * `getGuardianAccessToken` `TokenResult`, mirrored into the dev server's HTTP
 * status code); this preserves it across the seam rather than collapsing it
 * into a bare `Error`.
 */
export class GuardianTokenError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "GuardianTokenError";
    this.status = status;
  }
}

/**
 * True when a connect failure means the guardian token is gone for good — the
 * host reported it missing (404) or expired with a failed refresh (401) — so
 * only a re-provision (`wake --repair-guardian`, or re-hatching) can recover.
 * 403 (refused loopback boundary) and transient host/network failures return
 * false; those are not fixable by re-provisioning.
 */
export function requiresGuardianReprovision(error: unknown): boolean {
  return (
    error instanceof GuardianTokenError &&
    (error.status === 404 || error.status === 401)
  );
}

// ---------------------------------------------------------------------------
// Transport availability
// ---------------------------------------------------------------------------

/** Failure surfaced when no local-mode host backs this runtime. */
const LOCAL_HOST_UNAVAILABLE_ERROR =
  "The local assistant host isn't available here.";

function readInjectedConfig(): { mode?: string } | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as { __VELLUM_CONFIG__?: { mode?: string } })
    .__VELLUM_CONFIG__;
}

/**
 * Whether a local-mode host (the Electron IPC bridge, the Vite dev server, or
 * the `vellum client` CLI server) backs this runtime and can serve
 * `/assistant/__local/*`. The managed web build and the remote-web tunnel
 * cannot, yet both still surface local / self-hosted assistants via the platform
 * `is_local` flag — so callers and UI MUST consult this before offering a local
 * action (wake / hatch / retire).
 *
 * Detected from the runtime config the capable hosts inject
 * (`window.__VELLUM_CONFIG__`), excluding remote-gateway mode.
 */
export function isLocalModeHostAvailable(): boolean {
  if (isElectron()) return true;
  const config = readInjectedConfig();
  if (!config) return false;
  if (config.mode === "remote-gateway") return false;
  return true;
}

/**
 * POST a local-mode command and read back its `{ ok, ... }` result. Always
 * resolves, never throws: an unavailable host (no request sent) and a non-JSON
 * response both resolve to `{ ok: false }`.
 */
async function postLocalCommand<T extends { ok: boolean }>(
  path: string,
  body: unknown,
  unavailableError: string,
): Promise<T | { ok: false; error: string }> {
  if (!isLocalModeHostAvailable()) {
    return { ok: false, error: unavailableError };
  }
  let res: Response;
  try {
    res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    return { ok: false, error: unavailableError };
  }
  const parsed = (await res.json().catch(() => null)) as T | null;
  return parsed ?? { ok: false, error: unavailableError };
}

/**
 * Provision a local assistant for the requested species.
 *
 * Both hosts spawn the Vellum CLI in a trusted process and return the same
 * `{ ok, assistantId }` contract: the Electron main process behind
 * `window.vellum.localMode.hatch`, the Vite dev server behind the
 * `/assistant/__local/hatch` middleware. Callers reload the lockfile to
 * discover the new assistant regardless of host.
 */
export async function hatchLocalAssistant(
  species: string = "vellum",
  remote?: string,
): Promise<LocalHatchResult> {
  if (isElectron()) {
    return window.vellum!.localMode.hatch(species, remote);
  }

  return postLocalCommand<LocalHatchResult>(
    "/assistant/__local/hatch",
    { species, remote },
    LOCAL_HOST_UNAVAILABLE_ERROR,
  );
}

/**
 * Read the local-assistant lockfile (sensitive fields stripped by the host).
 * Throws on a transport/parse failure so callers can fall back to a cached
 * copy; the Electron main reads the file directly, the dev host serves it from
 * `/assistant/__local/lockfile`.
 */
export async function loadLockfileHost(): Promise<Lockfile> {
  if (isElectron()) {
    return window.vellum!.localMode.readLockfile();
  }

  const res = await fetch("/assistant/__local/lockfile");
  if (!res.ok) throw new Error(`lockfile fetch failed: ${res.status}`);
  return res.json() as Promise<Lockfile>;
}

/**
 * Insert or update one assistant in the lockfile and optionally set the active
 * assistant. Resolves with the updated lockfile or a `{ ok: false, error }`
 * failure rather than throwing, matching `hatchLocalAssistant`.
 */
export async function saveLockfileAssistantHost(
  assistant: Record<string, unknown>,
  activeAssistant: string | undefined,
): Promise<LockfileWriteResult> {
  if (isElectron()) {
    return window.vellum!.localMode.saveLockfileAssistant(
      assistant,
      activeAssistant,
    );
  }

  return postLocalCommand<LockfileWriteResult>(
    "/assistant/__local/lockfile",
    { assistant, activeAssistant },
    LOCAL_HOST_UNAVAILABLE_ERROR,
  );
}

/**
 * Replace the platform (`cloud === "vellum"`) assistants in the lockfile with
 * the provided set, preserving local assistants. When `organizationId` is
 * given, only that org's platform entries are replaced — other orgs' entries
 * are preserved; omitting it does the legacy full replace. Same never-throw
 * contract as `saveLockfileAssistantHost`.
 */
export async function replacePlatformAssistantsHost(
  platformAssistants: Array<Record<string, unknown>>,
  organizationId?: string,
): Promise<LockfileWriteResult> {
  if (isElectron()) {
    return window.vellum!.localMode.replacePlatformAssistants(
      platformAssistants,
      organizationId,
    );
  }

  return postLocalCommand<LockfileWriteResult>(
    "/assistant/__local/lockfile",
    { syncPlatform: true, platformAssistants, organizationId },
    LOCAL_HOST_UNAVAILABLE_ERROR,
  );
}

/**
 * Retire a local assistant. Both hosts drive the Vellum CLI's `retire` in a
 * trusted process and return the same `{ ok, error }` contract.
 */
export async function retireLocalAssistantHost(
  assistantId: string,
): Promise<LocalRetireResult> {
  if (isElectron()) {
    return window.vellum!.localMode.retire(assistantId);
  }

  return postLocalCommand<LocalRetireResult>(
    "/assistant/__local/retire",
    { assistantId },
    LOCAL_HOST_UNAVAILABLE_ERROR,
  );
}

/**
 * Stop a local assistant's daemon and gateway. Both hosts drive the Vellum
 * CLI's `sleep --force` in a trusted process and return the same `{ ok, error }`
 * contract. Used as the first half of a restart (sleep → wake).
 */
export async function sleepLocalAssistantHost(
  assistantId: string,
): Promise<LocalSleepResult> {
  if (isElectron()) {
    const sleep = window.vellum!.localMode.sleep;
    if (!sleep) {
      return { ok: false, error: "Sleep is not supported by this app version" };
    }
    return sleep(assistantId);
  }

  return postLocalCommand<LocalSleepResult>(
    "/assistant/__local/sleep",
    { assistantId },
    LOCAL_HOST_UNAVAILABLE_ERROR,
  );
}

/**
 * Wake (start/restart) a local assistant's daemon and gateway, re-seeding its
 * guardian token. Both hosts drive the Vellum CLI's `wake` in a trusted
 * process and return the same `{ ok, error }` contract.
 *
 * This is the non-destructive repair primitive: it revives a stopped or
 * mis-seeded assistant in place without touching its data or identity, the
 * counterpart to {@link retireLocalAssistantHost}'s destructive removal.
 * A plain wake (no options) is the safe auto-repair primitive. Passing
 * `repairGuardian: true` re-provisions the guardian token and revokes the
 * assistant's other device-bound tokens, so it must only be passed from
 * explicitly user-confirmed flows — never from silent auto-repair paths.
 * Older Electron hosts that predate this IPC channel resolve `wake` as
 * `undefined`; callers treat that as a no-op repair and fall through to the
 * underlying connect error. Older preloads whose `wake` takes one parameter
 * silently ignore the extra options argument at the JS level, so a plain
 * wake still succeeds — the same graceful degradation for version skew.
 */
export async function wakeLocalAssistantHost(
  assistantId: string,
  options?: LocalWakeOptions,
): Promise<LocalWakeResult> {
  if (isElectron()) {
    const wake = window.vellum!.localMode.wake;
    if (!wake) {
      return { ok: false, error: "Wake is not supported by this app version" };
    }
    return wake(assistantId, options);
  }

  return postLocalCommand<LocalWakeResult>(
    "/assistant/__local/wake",
    { assistantId, repairGuardian: options?.repairGuardian },
    "Wake failed. Try running vellum wake in your terminal.",
  );
}

export async function upgradeLocalAssistantHost(
  assistantId: string,
  options?: LocalUpgradeOptions,
): Promise<LocalUpgradeResult> {
  if (isElectron()) {
    const upgrade = window.vellum!.localMode.upgrade;
    if (!upgrade) {
      return {
        ok: false,
        error: "Update and restart the desktop app to enable local upgrades.",
      };
    }
    return upgrade(assistantId, options);
  }

  const body = {
    assistantId,
    ...(options?.latest ? { latest: true } : {}),
    ...(options?.version ? { version: options.version } : {}),
    ...(options?.force ? { force: true } : {}),
  };

  const res = await fetch("/assistant/__local/upgrade", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json() as Promise<LocalUpgradeResult>;
}

export async function getLocalAssistantStatusHost(
  assistantId: string,
): Promise<LocalAssistantStatusResult> {
  if (isElectron()) {
    const status = window.vellum!.localMode.status;
    if (!status) {
      return {
        ok: false,
        status: 501,
        error: "Local assistant status is not supported by this app version",
      };
    }
    return status(assistantId);
  }

  if (!isLocalModeHostAvailable()) {
    return { ok: false, status: 0, error: LOCAL_HOST_UNAVAILABLE_ERROR };
  }
  let res: Response;
  try {
    res = await fetch(
      `/assistant/__local/status/${encodeURIComponent(assistantId)}`,
    );
  } catch {
    return { ok: false, status: 0, error: LOCAL_HOST_UNAVAILABLE_ERROR };
  }
  const parsed = (await res
    .json()
    .catch(() => null)) as LocalAssistantStatusResult | null;
  return (
    parsed ?? {
      ok: false,
      status: res.status,
      error: LOCAL_HOST_UNAVAILABLE_ERROR,
    }
  );
}

/**
 * Acquire a fresh guardian access token for a local assistant, used to
 * authorize the gateway token exchange. Reading the token file and refreshing
 * it via the CLI is a trusted disk/CLI operation, so it runs in the host:
 * the Electron main process behind `window.vellum.localMode.guardianToken`,
 * the Vite dev server behind `/assistant/__local/guardian-token/{id}`. Throws
 * a {@link GuardianTokenError} carrying the host's status on failure, so
 * callers surface the same connect error — and can branch on the failure
 * class — regardless of host.
 */
export async function fetchGuardianTokenHost(
  assistantId: string,
): Promise<string> {
  if (isElectron()) {
    const result = await window.vellum!.localMode.guardianToken(assistantId);
    if (!result.ok) throw new GuardianTokenError(result.status, result.error);
    return result.accessToken;
  }

  const res = await fetch(
    `/assistant/__local/guardian-token/${encodeURIComponent(assistantId)}`,
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new GuardianTokenError(
      res.status,
      body.error ?? `Guardian token request failed: ${res.status}`,
    );
  }
  const { accessToken } = (await res.json()) as { accessToken: string };
  return accessToken;
}

/**
 * Clear the platform session token on logout. Best-effort.
 */
export async function clearLocalPlatformSession(): Promise<void> {
  if (!isLocalModeHostAvailable()) return;
  try {
    await fetch("/assistant/__local/platform-session", { method: "DELETE" });
  } catch {
    // best-effort — the server is going away or already cleared.
  }
}
