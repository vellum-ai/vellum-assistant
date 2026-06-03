import { app } from "electron";
import path from "node:path";
import { z } from "zod";

import {
  getGuardianAccessToken,
  getLockfileData,
  replacePlatformAssistants,
  resolveConfigDir,
  resolveLockfilePaths,
  runHatch,
  runRetire,
  upsertLockfileAssistant,
  type CliInvocation,
  type LockfileWriteResult,
  type TokenResult,
} from "@vellumai/local-mode";
import { handle } from "./ipc";

/**
 * Local-mode host bridge: provisions and retires local assistants and reads
 * and writes the lockfile, exposed to the renderer as `window.vellum.localMode.*`.
 *
 * Lifecycle ops delegate to `@vellumai/local-mode`, the shared host library
 * that also backs the web app's dev-server middleware
 * (`apps/web/vite-plugin-local-mode.ts`). The CLI is driven as a subprocess
 * rather than imported in-process so the CLI's own dependency tree never
 * enters this package's typecheck or bundle; the shared library owns the
 * spawn/parse and lockfile-on-disk logic so each host wires transport once.
 *
 * The CLI owns all daemon + gateway process lifecycle: a hatched local
 * assistant runs its own daemon, and this host only ever invokes the CLI as a
 * subprocess. The Electron app does not supervise any daemon of its own.
 */

const DEFAULT_SPECIES = "vellum";
const PACKAGED_UNSUPPORTED =
  "Local assistants aren't supported in the packaged app yet.";

interface HatchResult {
  ok: boolean;
  assistantId?: string;
  error?: string;
}

interface RetireResult {
  ok: boolean;
  error?: string;
}

/**
 * How to invoke the CLI for local lifecycle ops, or `null` when no CLI is
 * available to invoke.
 *  - Dev: the monorepo source tree, run via `bun run <repo>/cli/src/index.ts
 *    <subcommand> …`. `app.getAppPath()` is `apps/macos`; the repo root is
 *    two levels up.
 *  - Packaged: unsupported for now. No CLI-capable runtime is bundled yet, so
 *    this returns `null` and lifecycle ops fail explicitly rather than trying
 *    to invoke a binary that isn't there. Bundling a bun runtime and lazily
 *    installing the CLI in packaged builds is tracked in LUM-2085.
 */
function resolveCliInvocation(): CliInvocation | null {
  if (app.isPackaged) return null;
  const repoRoot = path.resolve(app.getAppPath(), "..", "..");
  const cliEntry = path.join(repoRoot, "cli", "src", "index.ts");
  return { command: "bun", baseArgs: ["run", cliEntry] };
}

/**
 * Provision a local assistant for the requested species. Never rejects —
 * failures resolve with `{ ok: false, error }` so the renderer renders the
 * same error UI it shows for the web/dev middleware path.
 */
async function hatch(species: string): Promise<HatchResult> {
  const invocation = resolveCliInvocation();
  if (invocation === null) return { ok: false, error: PACKAGED_UNSUPPORTED };
  const result = await runHatch(invocation, species);
  return result.ok
    ? { ok: true, assistantId: result.assistantId }
    : { ok: false, error: result.error };
}

/** Retire a local assistant. Mirrors `hatch`'s never-reject contract. */
async function retire(assistantId: string): Promise<RetireResult> {
  const invocation = resolveCliInvocation();
  if (invocation === null) return { ok: false, error: PACKAGED_UNSUPPORTED };
  const result = await runRetire(invocation, assistantId);
  return result.ok ? { ok: true } : { ok: false, error: result.error };
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

  // `species` is optional on the wire so an empty/omitted request
  // falls back to the default rather than being rejected.
  handle(
    "vellum:localMode:hatch",
    z.tuple([z.string().optional()]),
    ([species]) => hatch(species && species.length > 0 ? species : DEFAULT_SPECIES),
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
    z.tuple([z.array(assistantRecord)]),
    ([list]): LockfileWriteResult => {
      const result = replacePlatformAssistants(lockfilePaths, list);
      return result.ok
        ? { ok: true, lockfile: result.lockfile }
        : { ok: false, error: result.error };
    },
  );

  handle("vellum:localMode:retire", assistantIdArgs, ([assistantId]) => {
    if (!assistantId) return { ok: false, error: "Missing assistantId" };
    return retire(assistantId);
  });

  handle(
    "vellum:localMode:guardianToken",
    assistantIdArgs,
    ([assistantId]): Promise<TokenResult> => {
      if (!assistantId) {
        return Promise.resolve({
          ok: false,
          status: 400,
          error: "Missing assistantId",
        });
      }
      const invocation = resolveCliInvocation();
      if (invocation === null) {
        return Promise.resolve({
          ok: false,
          status: 501,
          error: PACKAGED_UNSUPPORTED,
        });
      }
      return getGuardianAccessToken(assistantId, configDir, invocation, true);
    },
  );
};
