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
 * Both branches return the same wire contract (the types below), so callers
 * never observe which host they're on. The seam owns these contract types so
 * `lib/` can depend on `runtime/` without `runtime/` reaching back into
 * `lib/`.
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

export interface LocalHatchResult {
  ok: boolean;
  assistantId?: string;
  error?: string;
}

export type LockfileWriteResult =
  | { ok: true; lockfile: Lockfile }
  | { ok: false; error: string };

export interface LocalRetireResult {
  ok: boolean;
  error?: string;
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
): Promise<LocalHatchResult> {
  if (isElectron()) {
    return window.vellum!.localMode.hatch(species);
  }

  const res = await fetch("/assistant/__local/hatch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ species }),
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
    return (await window.vellum!.localMode.readLockfile()) as unknown as Lockfile;
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
    ) as Promise<LockfileWriteResult>;
  }

  const res = await fetch("/assistant/__local/lockfile", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ assistant, activeAssistant }),
  });
  return res.json() as Promise<LockfileWriteResult>;
}

/**
 * Replace every platform (`cloud === "vellum"`) assistant in the lockfile with
 * the provided set, preserving local assistants. Same never-throw contract as
 * `saveLockfileAssistantHost`.
 */
export async function replacePlatformAssistantsHost(
  platformAssistants: Array<Record<string, unknown>>,
): Promise<LockfileWriteResult> {
  if (isElectron()) {
    return window.vellum!.localMode.replacePlatformAssistants(
      platformAssistants,
    ) as Promise<LockfileWriteResult>;
  }

  const res = await fetch("/assistant/__local/lockfile", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ syncPlatform: true, platformAssistants }),
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
 * Acquire a fresh guardian access token for a local assistant, used to
 * authorize the gateway token exchange. Reading the token file and refreshing
 * it via the CLI is a trusted disk/CLI operation, so it runs in the host:
 * the Electron main process behind `window.vellum.localMode.guardianToken`,
 * the Vite dev server behind `/assistant/__local/guardian-token/{id}`. Throws
 * on failure so callers surface the same connect error regardless of host.
 */
export async function fetchGuardianTokenHost(
  assistantId: string,
): Promise<string> {
  if (isElectron()) {
    const result = await window.vellum!.localMode.guardianToken(assistantId);
    if (!result.ok) throw new Error(result.error);
    return result.accessToken;
  }

  const res = await fetch(
    `/assistant/__local/guardian-token/${encodeURIComponent(assistantId)}`,
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(
      body.error ?? `Guardian token request failed: ${res.status}`,
    );
  }
  const { accessToken } = (await res.json()) as { accessToken: string };
  return accessToken;
}
