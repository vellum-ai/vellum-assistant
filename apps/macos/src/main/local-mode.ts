import { app, ipcMain } from "electron";
import { spawn } from "node:child_process";
import path from "node:path";

/**
 * Local-mode lifecycle bridge: provisions local assistants via the Vellum
 * CLI, exposed to the renderer as `window.vellum.localMode.*`.
 *
 * The CLI is invoked as a subprocess rather than imported in-process. This
 * keeps `apps/macos` an independent build unit: the CLI's own dependency tree
 * is never pulled into this package's typecheck or bundle (CI installs only
 * this package's deps). It also matches every other CLI consumer — the dev
 * server's `apps/web/vite-plugin-local-mode.ts` and the daemon supervisor in
 * `index.ts` both spawn the CLI rather than linking its source.
 *
 * DEP-2: a hatched local assistant runs its own daemon + gateway, while
 * `index.ts` also supervises a bundled daemon via `spawnDaemon`. The two
 * ownership models only collide in a packaged build (which doesn't exist
 * yet); reconciling them is tracked in LUM-2085 and is out of scope here.
 */

const DEFAULT_SPECIES = "vellum";
const HATCH_TIMEOUT_MS = 120_000;

/**
 * How to invoke the CLI, in the two runtime shapes the app ships in:
 *  - Packaged: the compiled single-file `bun` executable in `Resources/`
 *    (the same artifact the daemon supervisor spawns), invoked as
 *    `<resources>/bun <subcommand> …`.
 *  - Dev: the monorepo source tree, run via `bun run <repo>/cli/src/index.ts
 *    <subcommand> …`. `app.getAppPath()` is `apps/macos`; the repo root is
 *    two levels up.
 */
function resolveCliInvocation(): { command: string; baseArgs: string[] } {
  if (app.isPackaged) {
    return { command: path.join(process.resourcesPath, "bun"), baseArgs: [] };
  }
  const repoRoot = path.resolve(app.getAppPath(), "..", "..");
  const cliEntry = path.join(repoRoot, "cli", "src", "index.ts");
  return { command: "bun", baseArgs: ["run", cliEntry] };
}

interface HatchResult {
  ok: boolean;
  assistantId?: string;
  error?: string;
}

/**
 * Spawn `vellum hatch <species>` and resolve with the new assistant's id.
 * Never rejects — failures resolve with `{ ok: false, error }` so the
 * renderer renders the same error UI it shows for the dev-middleware path.
 * The id is read from the CLI's stdout, matching the dev middleware's
 * contract (`apps/web/vite-plugin-local-mode.ts`).
 */
function runHatch(species: string): Promise<HatchResult> {
  return new Promise((resolve) => {
    const { command, baseArgs } = resolveCliInvocation();
    const child = spawn(command, [...baseArgs, "hatch", species], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const settle = (result: HatchResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    };

    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      settle({ ok: false, error: "Hatch timed out after 120 seconds" });
    }, HATCH_TIMEOUT_MS);

    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      process.stdout.write(`[local-mode] ${text}`);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      process.stderr.write(`[local-mode] ${text}`);
    });

    child.on("error", (err) => {
      settle({ ok: false, error: `Failed to spawn CLI: ${err.message}` });
    });

    child.on("close", (code) => {
      if (code === 0) {
        const match = stdout.match(/Hatching local assistant:\s+(.+)/);
        settle({ ok: true, assistantId: match?.[1]?.trim() ?? "" });
      } else {
        settle({ ok: false, error: stderr.trim() || stdout.trim() });
      }
    });
  });
}

let installed = false;

/**
 * Register the local-mode IPC handlers. Call once from `whenReady`.
 * Idempotent so it's safe under main-bundle hot reload in dev.
 */
export const installLocalMode = (): void => {
  if (installed) return;
  installed = true;

  ipcMain.handle("vellum:localMode:hatch", (_event, species: unknown) => {
    const requested =
      typeof species === "string" && species.length > 0
        ? species
        : DEFAULT_SPECIES;
    return runHatch(requested);
  });
};
