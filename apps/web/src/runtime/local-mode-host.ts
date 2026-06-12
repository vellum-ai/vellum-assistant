import type { LocalWakeOptions } from "@vellumai/ipc-contract";
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
 * `runtime/` wrapper rule in `apps/web/docs/ELECTRON.md`.
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

export interface LocalWakeResult {
  ok: boolean;
  error?: string;
}

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

  const res = await fetch("/assistant/__local/hatch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ species, remote }),
  });
  return res.json() as Promise<LocalHatchResult>;
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

  const res = await fetch("/assistant/__local/lockfile", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ assistant, activeAssistant }),
  });
  return res.json() as Promise<LockfileWriteResult>;
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

  const res = await fetch("/assistant/__local/lockfile", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ syncPlatform: true, platformAssistants, organizationId }),
  });
  return res.json() as Promise<LockfileWriteResult>;
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

  const res = await fetch("/assistant/__local/retire", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ assistantId }),
  });
  return res.json() as Promise<LocalRetireResult>;
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

  const res = await fetch("/assistant/__local/wake", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      assistantId,
      repairGuardian: options?.repairGuardian,
    }),
  });
  return res.json() as Promise<LocalWakeResult>;
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
