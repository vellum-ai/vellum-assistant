import { app } from "electron";
import { existsSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

import {
  getGuardianAccessToken,
  isActiveAssistant,
  getLockfileData,
  getLocalAssistantStatus,
  replacePlatformAssistants,
  resolveConfigDir,
  resolveEnvironmentName,
  resolveLockfilePaths,
  runHatch,
  runRetire,
  runSleep,
  runUpgrade,
  runWake,
  upsertLockfileAssistant,
  type CliInvocation,
  type LockfileWriteResult,
  type TokenResult,
  type UpgradeOptions,
  type WakeOptions,
} from "@vellumai/local-mode";
import { handle } from "./ipc";

import {
  ensureCliInstalled,
  getBundledBunPath,
  getCliBinPath,
} from "./cli-installer";
import { getSessionToken } from "./session-token-store";

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

/**
 * Resolve how to invoke the CLI. Precedence:
 *  1. `VELLUM_CLI_PATH` env var override
 *  2. Dev source tree (when `!app.isPackaged`)
 *  3. `ensureCliInstalled()` — early-returns when already installed and
 *     refreshes the PATH-wrapper locator either way
 *
 * Throws when no CLI path can be resolved (e.g. install fails).
 */
export async function resolveCliInvocation(): Promise<CliInvocation> {
  const envPath = process.env.VELLUM_CLI_PATH;
  if (envPath) {
    return { command: "bun", baseArgs: ["run", envPath] };
  }

  if (!app.isPackaged) {
    const repoRoot = path.resolve(app.getAppPath(), "..", "..");
    const cliEntry = path.join(repoRoot, "cli", "src", "index.ts");
    if (existsSync(cliEntry)) {
      return { command: "bun", baseArgs: ["run", cliEntry] };
    }
  }

  await ensureCliInstalled();
  return { command: getBundledBunPath(), baseArgs: ["run", getCliBinPath()] };
}

/**
 * Provision a local assistant for the requested species. Never rejects —
 * failures resolve with `{ ok: false, error }` so the renderer renders the
 * same error UI it shows for the web/dev middleware path.
 */
async function hatch(species: string, remote?: string): Promise<HatchResult> {
  let invocation: CliInvocation;
  try {
    invocation = await resolveCliInvocation();
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
    invocation = await resolveCliInvocation();
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
  const result = await runRetire(invocation, assistantId, {
    platformToken: getSessionToken() ?? undefined,
  });
  return result.ok ? { ok: true } : { ok: false, error: result.error };
}

/** Stop a local assistant's daemon and gateway. Mirrors `hatch`'s never-reject contract. */
async function sleep(assistantId: string): Promise<SleepResult> {
  let invocation: CliInvocation;
  try {
    invocation = await resolveCliInvocation();
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
  const result = await runSleep(invocation, assistantId);
  return result.ok ? { ok: true } : { ok: false, error: result.error };
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
    invocation = await resolveCliInvocation();
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
    invocation = await resolveCliInvocation();
  } catch (err) {
    upgradingLocalAssistantIds.delete(assistantId);
    return { ok: false, error: (err as Error).message };
  }

  try {
    const result = await runUpgrade(invocation, assistantId, options);
    if (!result.ok) return { ok: false, error: result.error };
    return result.version
      ? { ok: true, version: result.version }
      : { ok: true };
  } finally {
    upgradingLocalAssistantIds.delete(assistantId);
  }
}

// A persisted assistant entry as it crosses the IPC boundary. The
// package's lockfile parser owns the real field-level contract; here we
// only assert the renderer sent an object, so unknown/forward-compat
// fields pass through untouched.
const assistantRecord = z.record(z.string(), z.unknown());

// `retire` and `guardianToken` both take a single assistant id and keep a
// never-reject contract: a missing id resolves with a structured error the
// renderer renders, rather than rejecting the invoke. The id is therefore
// optional on the wire and validated in the body.
const assistantIdArgs = z.tuple([z.string().optional()]);

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
  if (installed) return;
  installed = true;

  const lockfilePaths = resolveLockfilePaths(process.env);
  const configDir = resolveConfigDir(process.env);
  // Pin the environment the guardian-token CLI subprocess (refresh/lease) sees
  // to the same one `configDir` was resolved from, so the token is always read
  // and written under the same env dir. Overlaid on `process.env` by the host
  // seam, so PATH etc. are preserved.
  const guardianTokenEnv = {
    VELLUM_ENVIRONMENT: resolveEnvironmentName(process.env),
  };

  // `species` is optional on the wire so an empty/omitted request
  // falls back to the default rather than being rejected.
  handle(
    "vellum:localMode:hatch",
    z.tuple([z.string().optional(), z.string().optional()]),
    ([species, remote]) =>
      hatch(
        species && species.length > 0 ? species : DEFAULT_SPECIES,
        remote || undefined,
      ),
  );

  handle("vellum:localMode:readLockfile", z.tuple([]), () => {
    const result = getLockfileData(lockfilePaths);
    if (result.ok) return result.data;
    throw new Error(
      result.error ?? `Failed to read lockfile (status ${result.status})`,
    );
  });

  handle(
    "vellum:localMode:saveLockfileAssistant",
    z.tuple([assistantRecord, z.string().optional()]),
    ([assistant, activeAssistant]): LockfileWriteResult => {
      const result = upsertLockfileAssistant(
        lockfilePaths,
        assistant,
        activeAssistant,
      );
      return result.ok
        ? { ok: true, lockfile: result.lockfile }
        : { ok: false, error: result.error };
    },
  );

  handle(
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

  handle("vellum:localMode:retire", assistantIdArgs, ([assistantId]) => {
    if (!assistantId) return { ok: false, error: "Missing assistantId" };
    return retire(assistantId);
  });

  handle("vellum:localMode:sleep", assistantIdArgs, ([assistantId]) => {
    if (!assistantId) return { ok: false, error: "Missing assistantId" };
    return sleep(assistantId);
  });

  handle("vellum:localMode:wake", wakeArgs, ([assistantId, options]) => {
    if (!assistantId) return { ok: false, error: "Missing assistantId" };
    return wake(assistantId, options);
  });

  handle("vellum:localMode:upgrade", upgradeArgs, ([assistantId, options]) => {
    if (!assistantId) return { ok: false, error: "Missing assistantId" };
    return upgrade(lockfilePaths, assistantId, options);
  });

  handle("vellum:localMode:status", assistantIdArgs, ([assistantId]) => {
    if (!assistantId) {
      return { ok: false, status: 400, error: "Missing assistantId" };
    }
    if (upgradingLocalAssistantIds.has(assistantId)) {
      return { ok: true, state: "upgrading" };
    }
    return getLocalAssistantStatus(lockfilePaths, assistantId);
  });

  handle(
    "vellum:localMode:guardianToken",
    assistantIdArgs,
    async ([assistantId]): Promise<TokenResult> => {
      if (!assistantId) {
        return { ok: false, status: 400, error: "Missing assistantId" };
      }
      let invocation: CliInvocation;
      try {
        invocation = await resolveCliInvocation();
      } catch (err) {
        return { ok: false, status: 500, error: (err as Error).message };
      }
      return getGuardianAccessToken(
        assistantId,
        configDir,
        invocation,
        true,
        guardianTokenEnv,
      );
    },
  );
};
