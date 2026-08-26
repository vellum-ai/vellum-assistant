import { z } from "zod";

import {
  connectImport,
  getGuardianAccessToken,
  getPairedGuardianAccessToken as getStoredPairedGuardianAccessToken,
  isActiveAssistant,
  isPairedLockfileEntry,
  renameLockfileAssistantIfPresent,
  PAIRED_GUARDIAN_TOKEN_HOST_ONLY_ERROR,
  getLockfileData,
  getLocalAssistantStatus,
  replacePlatformAssistants,
  runDevicesList,
  runDevicesRevoke,
  runHatch,
  runRetire,
  runSleep,
  runUpgrade,
  runWake,
  unpairAssistant,
  upsertRendererLockfileAssistant,
  type CliInvocation,
  type GuardianTokenOptions,
  type LockfileWriteResult,
  type TokenResult,
  type UpgradeOptions,
  type WakeOptions,
} from "@vellumai/local-mode";
import type {
  LocalConnectImportResult,
  LocalListDevicesResult,
  LocalRevokeDeviceResult,
} from "@vellumai/ipc-contract";
import { capabilityToken } from "./capability-registry";
import type { IpcHandle } from "./ipc";

/**
 * Local-mode host bridge: provisions and retires local assistants and reads
 * and writes the lockfile, exposed to the renderer as `window.vellum.localMode.*`.
 *
 * Lifecycle ops delegate to `@vellumai/local-mode`, the shared host library
 * that also backs the web app's dev-server middleware
 * (`clients/web/vite-plugin-local-mode.ts`). The CLI is driven as a subprocess
 * rather than imported in-process so the CLI's own dependency tree never
 * enters this package's typecheck or bundle; the shared library owns the
 * spawn/parse and lockfile-on-disk logic so each host wires transport once.
 *
 * The CLI owns all daemon + gateway process lifecycle: a hatched local
 * assistant runs its own daemon, and this host only ever invokes the CLI as a
 * subprocess. The Electron app does not supervise any daemon of its own.
 */

const DEFAULT_SPECIES = "vellum";

interface HatchResult {
  ok: boolean;
  assistantId?: string;
  error?: string;
}

interface RetireResult {
  ok: boolean;
  error?: string;
}

interface WakeResult {
  ok: boolean;
  error?: string;
}

interface UpgradeResult {
  ok: boolean;
  version?: string;
  error?: string;
}

export interface LocalModeCliProvider {
  resolveInvocation: () => Promise<CliInvocation>;
}

export interface LocalModeSessionProvider {
  getToken: () => string | null;
}

export interface LocalModePlatformPaths {
  configDir: string;
  environment: string;
  lockfilePaths: string[];
}

export const LOCAL_MODE_CLI = capabilityToken<LocalModeCliProvider>(
  "desktop.local-mode-cli",
);
export const LOCAL_MODE_SESSION = capabilityToken<LocalModeSessionProvider>(
  "desktop.local-mode-session",
);
export const LOCAL_MODE_PATHS = capabilityToken<LocalModePlatformPaths>(
  "desktop.local-mode-paths",
);

export interface LocalModeRuntime {
  cli: LocalModeCliProvider;
  handle: IpcHandle;
  paths: LocalModePlatformPaths;
  refreshLockfile: () => void;
  session: LocalModeSessionProvider;
  unavailableError?: string;
}

let runtime: LocalModeRuntime | null = null;

export const configureLocalMode = (next: LocalModeRuntime): void => {
  runtime = next;
};

export const configureUnavailableLocalMode = (
  handle: IpcHandle,
  unavailableError: string,
): void => {
  configureLocalMode({
    cli: {
      resolveInvocation: async () => ({ command: "unused", baseArgs: [] }),
    },
    handle,
    paths: { configDir: "", environment: "", lockfilePaths: [] },
    refreshLockfile: () => undefined,
    session: { getToken: () => null },
    unavailableError,
  });
};

const requireRuntime = (): LocalModeRuntime => {
  if (!runtime) {
    throw new Error("Local-mode runtime is unavailable");
  }
  return runtime;
};

/**
 * Provision a local assistant for the requested species. Never rejects —
 * failures resolve with `{ ok: false, error }` so the renderer renders the
 * same error UI it shows for the web/dev middleware path.
 */
async function hatch(species: string, remote?: string): Promise<HatchResult> {
  let invocation: CliInvocation;
  try {
    invocation = await requireRuntime().cli.resolveInvocation();
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
  const result = await runHatch(invocation, species, { remote });
  return result.ok
    ? { ok: true, assistantId: result.assistantId }
    : { ok: false, error: result.error };
}

interface SleepResult {
  ok: boolean;
  error?: string;
}

/** Retire a local assistant. Mirrors `hatch`'s never-reject contract. */
async function retire(assistantId: string): Promise<RetireResult> {
  let invocation: CliInvocation;
  try {
    invocation = await requireRuntime().cli.resolveInvocation();
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
  const result = await runRetire(invocation, assistantId, {
    platformToken: requireRuntime().session.getToken() ?? undefined,
  });
  return result.ok ? { ok: true } : { ok: false, error: result.error };
}

/** Stop a local assistant's daemon and gateway. Mirrors `hatch`'s never-reject contract. */
async function sleep(assistantId: string): Promise<SleepResult> {
  let invocation: CliInvocation;
  try {
    invocation = await requireRuntime().cli.resolveInvocation();
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
  const result = await runSleep(invocation, assistantId);
  return result.ok ? { ok: true } : { ok: false, error: result.error };
}

/** List a local assistant's paired devices. Mirrors `hatch`'s never-reject contract. */
async function listDevices(
  assistantId: string,
): Promise<LocalListDevicesResult> {
  let invocation: CliInvocation;
  try {
    invocation = await requireRuntime().cli.resolveInvocation();
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
  return runDevicesList(invocation, assistantId);
}

/** Revoke one paired device's tokens. Mirrors `hatch`'s never-reject contract. */
async function revokeDevice(
  assistantId: string,
  hashedDeviceId: string,
): Promise<LocalRevokeDeviceResult> {
  let invocation: CliInvocation;
  try {
    invocation = await requireRuntime().cli.resolveInvocation();
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
  return runDevicesRevoke(invocation, assistantId, hashedDeviceId);
}

/**
 * Wake (start) a local assistant's daemon and gateway, re-seeding its
 * guardian token. The non-destructive repair primitive. Mirrors `hatch`'s
 * never-reject contract.
 */
async function wake(
  assistantId: string,
  options?: WakeOptions,
): Promise<WakeResult> {
  let invocation: CliInvocation;
  try {
    invocation = await requireRuntime().cli.resolveInvocation();
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
  const result = await runWake(invocation, assistantId, options);
  return result.ok ? { ok: true } : { ok: false, error: result.error };
}

const upgradingLocalAssistantIds = new Set<string>();

async function upgrade(
  lockfilePaths: string[],
  assistantId: string,
  options?: UpgradeOptions,
): Promise<UpgradeResult> {
  if (!isActiveAssistant(lockfilePaths, assistantId)) {
    return { ok: false, error: "Can only upgrade the active local assistant" };
  }

  if (upgradingLocalAssistantIds.has(assistantId)) {
    return {
      ok: false,
      error: "An upgrade is already in progress for this assistant.",
    };
  }

  upgradingLocalAssistantIds.add(assistantId);

  let invocation: CliInvocation;
  try {
    invocation = await requireRuntime().cli.resolveInvocation();
  } catch (err) {
    upgradingLocalAssistantIds.delete(assistantId);
    return { ok: false, error: (err as Error).message };
  }

  try {
    const result = await runUpgrade(invocation, assistantId, options);
    if (!result.ok) {
      return { ok: false, error: result.error };
    }
    return result.version
      ? { ok: true, version: result.version }
      : { ok: true };
  } finally {
    upgradingLocalAssistantIds.delete(assistantId);
  }
}

async function getHostGuardianAccessToken(
  assistantId: string,
  configDir: string,
  options: GuardianTokenOptions,
): Promise<TokenResult> {
  let invocation: CliInvocation;
  try {
    invocation = await requireRuntime().cli.resolveInvocation();
  } catch (err) {
    return { ok: false, status: 500, error: (err as Error).message };
  }
  return getGuardianAccessToken(
    assistantId,
    configDir,
    invocation,
    true,
    { VELLUM_ENVIRONMENT: requireRuntime().paths.environment },
    options,
  );
}

/** Read a paired guardian bearer for the trusted main-process proxy. */
export async function getPairedGuardianAccessToken(
  assistantId: string,
  runtimeUrl: string,
): Promise<TokenResult> {
  let invocation: CliInvocation;
  try {
    invocation = await requireRuntime().cli.resolveInvocation();
  } catch (err) {
    return {
      ok: false,
      status: 500,
      error: (err as Error).message,
    };
  }
  return getStoredPairedGuardianAccessToken(
    assistantId,
    runtimeUrl,
    requireRuntime().paths.configDir,
    invocation,
    true,
    { VELLUM_ENVIRONMENT: requireRuntime().paths.environment },
  );
}

// A persisted assistant entry as it crosses the IPC boundary. The
// package's lockfile parser owns the real field-level contract; here we
// only assert the renderer sent an object, so unknown/forward-compat
// fields pass through untouched.
const assistantRecord = z.record(z.string(), z.unknown());

// `retire`, `unpair`, and `guardianToken` each take a single assistant id and
// keep a never-reject contract: a missing id resolves with a structured error
// the renderer renders, rather than rejecting the invoke. The id is therefore
// optional on the wire and validated in the body.
const assistantIdArgs = z.tuple([z.string().optional()]);

// `connectImport` (pairing bundle + optional local name) and `revokeDevice`
// (assistant id + hashed device id) each take two strings, optional on the
// wire and validated in the body (never-reject contract).
const twoOptionalStringArgs = z.tuple([
  z.string().optional(),
  z.string().optional(),
]);

// `wake` additionally takes an options object so a user-confirmed repair can
// pass `repairGuardian` through to the CLI's `--repair-guardian` flag. Both
// members stay optional so older renderers' single-argument invokes parse.
const wakeArgs = z.tuple([
  z.string().optional(),
  z.object({ repairGuardian: z.boolean().optional() }).optional(),
]);

const upgradeArgs = z.tuple([
  z.string().optional(),
  z
    .object({
      version: z.string().optional(),
      latest: z.boolean().optional(),
      force: z.boolean().optional(),
    })
    .optional(),
]);

let installed = false;

/**
 * Register the local-mode IPC handlers. Call once from `whenReady`.
 * Idempotent so it's safe under main-bundle hot reload in dev.
 */
export const installLocalMode = (): void => {
  if (installed) {
    return;
  }
  installed = true;

  const configured = requireRuntime();
  const { handle } = configured;
  const unavailableError = configured.unavailableError;
  const ipc: IpcHandle = (channel, schema, fn) => {
    handle(channel, schema, (args, event) => {
      if (!unavailableError) {
        return fn(args, event);
      }
      if (channel === "vellum:localMode:readLockfile") {
        throw new Error(unavailableError);
      }
      const hasStatus = channel.endsWith("Token") || channel.endsWith("status");
      return hasStatus
        ? { ok: false, status: 501, error: unavailableError }
        : { ok: false, error: unavailableError };
    });
  };

  const { configDir, lockfilePaths } = configured.paths;
  const { refreshLockfile } = configured;

  // `species` is optional on the wire so an empty/omitted request
  // falls back to the default rather than being rejected.
  ipc(
    "vellum:localMode:hatch",
    z.tuple([z.string().optional(), z.string().optional()]),
    ([species, remote]) =>
      hatch(
        species && species.length > 0 ? species : DEFAULT_SPECIES,
        remote || undefined,
      ),
  );

  ipc("vellum:localMode:readLockfile", z.tuple([]), () => {
    const result = getLockfileData(lockfilePaths);
    if (result.ok) {
      return result.data;
    }
    throw new Error(
      result.error ?? `Failed to read lockfile (status ${result.status})`,
    );
  });

  ipc(
    "vellum:localMode:saveLockfileAssistant",
    z.tuple([assistantRecord, z.string().optional()]),
    ([assistant, activeAssistant]): LockfileWriteResult => {
      const result = upsertRendererLockfileAssistant(
        lockfilePaths,
        assistant,
        activeAssistant,
      );
      return result.ok
        ? { ok: true, lockfile: result.lockfile }
        : { ok: false, error: result.error };
    },
  );

  // Rename-if-present: refuses missing entries and unreadable files instead
  // of upserting, so a stale renderer cache never re-creates an entry. Both
  // args stay optional on the wire, keeping the never-reject contract.
  ipc(
    "vellum:localMode:renameLockfileAssistant",
    z.tuple([z.string().optional(), z.string().optional()]),
    ([assistantId, name]): LockfileWriteResult => {
      if (!assistantId || !name) {
        return { ok: false, error: "Missing assistantId or name" };
      }
      const result = renameLockfileAssistantIfPresent(
        lockfilePaths,
        assistantId,
        name,
      );
      if (!result.ok) {
        return { ok: false, error: result.error };
      }
      // Refresh the watcher so lockfile-driven surfaces pick up the new name
      // in the same tick instead of after the next poll.
      refreshLockfile();
      return { ok: true, lockfile: result.lockfile };
    },
  );

  ipc(
    "vellum:localMode:replacePlatformAssistants",
    z.tuple([z.array(assistantRecord), z.string().optional()]),
    ([list, organizationId]): LockfileWriteResult => {
      const result = replacePlatformAssistants(
        lockfilePaths,
        list,
        organizationId,
      );
      return result.ok
        ? { ok: true, lockfile: result.lockfile }
        : { ok: false, error: result.error };
    },
  );

  ipc("vellum:localMode:retire", assistantIdArgs, ([assistantId]) => {
    if (!assistantId) {
      return { ok: false, error: "Missing assistantId" };
    }
    return retire(assistantId);
  });

  ipc(
    "vellum:localMode:unpair",
    assistantIdArgs,
    ([assistantId]): LockfileWriteResult => {
      if (!assistantId) {
        return { ok: false, error: "Missing assistantId" };
      }
      const result = unpairAssistant(lockfilePaths, configDir, assistantId);
      if (!result.ok) {
        return { ok: false, error: result.error };
      }
      // The paired-gateway forward resolves its allowlist from the watcher's
      // snapshot; refresh it now so the unpaired entry is rejected in the
      // same tick instead of after the next poll.
      refreshLockfile();
      return { ok: true, lockfile: result.lockfile };
    },
  );

  ipc(
    "vellum:localMode:connectImport",
    twoOptionalStringArgs,
    ([bundle, name]): LocalConnectImportResult => {
      const result = connectImport(lockfilePaths, configDir, { bundle, name });
      if (!result.ok) {
        return { ok: false, error: result.error };
      }
      refreshLockfile();
      return {
        ok: true,
        assistantId: result.assistantId,
        accessOnly: result.accessOnly,
      };
    },
  );

  ipc("vellum:localMode:sleep", assistantIdArgs, ([assistantId]) => {
    if (!assistantId) {
      return { ok: false, error: "Missing assistantId" };
    }
    return sleep(assistantId);
  });

  ipc("vellum:localMode:listDevices", assistantIdArgs, ([assistantId]) => {
    if (!assistantId) {
      return { ok: false, error: "Missing assistantId" };
    }
    return listDevices(assistantId);
  });

  ipc(
    "vellum:localMode:revokeDevice",
    twoOptionalStringArgs,
    ([assistantId, hashedDeviceId]) => {
      if (!assistantId) {
        return { ok: false, error: "Missing assistantId" };
      }
      if (!hashedDeviceId) {
        return { ok: false, error: "Missing hashedDeviceId" };
      }
      return revokeDevice(assistantId, hashedDeviceId);
    },
  );

  ipc("vellum:localMode:wake", wakeArgs, ([assistantId, options]) => {
    if (!assistantId) {
      return { ok: false, error: "Missing assistantId" };
    }
    return wake(assistantId, options);
  });

  ipc("vellum:localMode:upgrade", upgradeArgs, ([assistantId, options]) => {
    if (!assistantId) {
      return { ok: false, error: "Missing assistantId" };
    }
    return upgrade(lockfilePaths, assistantId, options);
  });

  ipc("vellum:localMode:status", assistantIdArgs, ([assistantId]) => {
    if (!assistantId) {
      return { ok: false, status: 400, error: "Missing assistantId" };
    }
    if (upgradingLocalAssistantIds.has(assistantId)) {
      return { ok: true, state: "upgrading" };
    }
    return getLocalAssistantStatus(lockfilePaths, assistantId);
  });

  ipc(
    "vellum:localMode:guardianToken",
    assistantIdArgs,
    async ([assistantId]): Promise<TokenResult> => {
      if (!assistantId) {
        return { ok: false, status: 400, error: "Missing assistantId" };
      }
      if (isPairedLockfileEntry(lockfilePaths, assistantId)) {
        return {
          ok: false,
          status: 403,
          error: PAIRED_GUARDIAN_TOKEN_HOST_ONLY_ERROR,
        };
      }
      return getHostGuardianAccessToken(assistantId, configDir, {
        paired: false,
      });
    },
  );
};
