import { app, ipcMain } from "electron";
import path from "node:path";

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

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

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

  ipcMain.handle("vellum:localMode:hatch", (_event, species: unknown) => {
    const requested =
      typeof species === "string" && species.length > 0
        ? species
        : DEFAULT_SPECIES;
    return hatch(requested);
  });

  ipcMain.handle("vellum:localMode:readLockfile", () => {
    const result = getLockfileData(lockfilePaths);
    if (result.ok) return result.data;
    throw new Error(
      result.error ?? `Failed to read lockfile (status ${result.status})`,
    );
  });

  ipcMain.handle(
    "vellum:localMode:saveLockfileAssistant",
    (_event, assistant: unknown, activeAssistant: unknown): LockfileWriteResult => {
      const result = upsertLockfileAssistant(
        lockfilePaths,
        asRecord(assistant),
        typeof activeAssistant === "string" ? activeAssistant : undefined,
      );
      return result.ok
        ? { ok: true, lockfile: result.lockfile }
        : { ok: false, error: result.error };
    },
  );

  ipcMain.handle(
    "vellum:localMode:replacePlatformAssistants",
    (_event, platformAssistants: unknown): LockfileWriteResult => {
      const list = Array.isArray(platformAssistants)
        ? platformAssistants.map(asRecord)
        : [];
      const result = replacePlatformAssistants(lockfilePaths, list);
      return result.ok
        ? { ok: true, lockfile: result.lockfile }
        : { ok: false, error: result.error };
    },
  );

  ipcMain.handle("vellum:localMode:retire", (_event, assistantId: unknown) => {
    if (typeof assistantId !== "string" || assistantId.length === 0) {
      return { ok: false, error: "Missing assistantId" };
    }
    return retire(assistantId);
  });

  ipcMain.handle(
    "vellum:localMode:guardianToken",
    (_event, assistantId: unknown): Promise<TokenResult> => {
      if (typeof assistantId !== "string" || assistantId.length === 0) {
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
      // The IPC channel is reachable only from our own renderer, so the
      // loopback gate the dev middleware enforces is implicit here.
      return getGuardianAccessToken(assistantId, configDir, invocation, true);
    },
  );
};
