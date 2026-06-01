import { ipcMain } from "electron";

import { hatchLocal } from "@vellumai/cli/src/lib/hatch-local";
import { VALID_SPECIES, type Species } from "@vellumai/cli/src/lib/constants";
import type { LifecycleReporter } from "@vellumai/cli/src/lib/lifecycle-reporter";

/**
 * Local-mode lifecycle bridge: runs the Vellum CLI's provisioning operations
 * in the Electron main process, exposed to the renderer as
 * `window.vellum.localMode.*`.
 *
 * The CLI work runs in-process here rather than by spawning the `vellum`
 * binary (the web/dev path's approach). The CLI exposes `hatchLocal` as a
 * plain async function whose transitive imports are pure lifecycle/config
 * helpers plus node builtins — no docker/aws/gcp surface — so the bundler
 * inlines it into the main bundle with no subprocess, binary, or PATH
 * dependency.
 *
 * DEP-2: `hatchLocal` starts the assistant's daemon + gateway as child
 * processes of main, while `index.ts` also supervises a bundled daemon via
 * `spawnDaemon`. The two ownership models only collide in a packaged build
 * (which doesn't exist yet); reconciling them is tracked in LUM-2085 and is
 * intentionally out of scope here.
 */

const DEFAULT_SPECIES: Species = "vellum";

// Mirror the web/dev middleware's lenient contract: an unknown species falls
// back to the default rather than rejecting, so the renderer's species
// selection can't hard-fail provisioning.
function coerceSpecies(value: string): Species {
  return (VALID_SPECIES as readonly string[]).includes(value)
    ? (value as Species)
    : DEFAULT_SPECIES;
}

// Surface the CLI's progress/log/warn/error to the main-process console
// instead of letting it write to stdout as if it were CLI output. This is
// the reason `hatchLocal` takes an injectable reporter — an embedding host
// observes progress without scraping a subprocess's terminal output.
const mainProcessReporter: LifecycleReporter = {
  progress: (step, total, label) =>
    console.log(`[local-mode] hatch ${step}/${total}: ${label}`),
  log: (message) => console.log(`[local-mode] ${message}`),
  warn: (message) => console.warn(`[local-mode] ${message}`),
  error: (message) => console.error(`[local-mode] ${message}`),
};

let installed = false;

/**
 * Register the local-mode IPC handlers. Call once from `whenReady`.
 * Idempotent so it's safe under main-bundle hot reload in dev.
 */
export const installLocalMode = (): void => {
  if (installed) return;
  installed = true;

  ipcMain.handle("vellum:localMode:hatch", async (_event, species: unknown) => {
    const requested = typeof species === "string" ? species : DEFAULT_SPECIES;
    try {
      const result = await hatchLocal(
        coerceSpecies(requested),
        null,
        false,
        false,
        {},
        {
          reporter: mainProcessReporter,
        },
      );
      return { ok: true, assistantId: result.assistantId };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });
};
