import { basename, join } from "node:path";

import type { PluginWorker } from "../plugin-api/plugin-worker.js";
import { getPluginActivationEligibility } from "./activation-eligibility.js";
import { listSurfaceDir, type SurfaceFile } from "./external-plugin-loader.js";
import { importWithTimeout } from "./surface-import.js";

export interface ExternalPluginWorkerSource extends SurfaceFile {
  readonly pluginId: string;
}

export interface ExternalPluginWorker extends ExternalPluginWorkerSource {
  readonly run: PluginWorker;
}

export class PluginWorkersIneligibleError extends Error {
  constructor(
    readonly pluginId: string,
    readonly reason: string,
  ) {
    super(`external plugin ${pluginId} is not eligible for workers: ${reason}`);
    this.name = "PluginWorkersIneligibleError";
  }
}

/** List worker files without importing plugin code. */
export function discoverExternalPluginWorkers(
  pluginDir: string,
): ExternalPluginWorkerSource[] {
  const pluginId = basename(pluginDir);
  return listSurfaceDir(join(pluginDir, "workers")).map((source) => ({
    ...source,
    pluginId,
  }));
}

/** Load every worker only after the plugin passes the static activation gate. */
export async function loadExternalPluginWorkers(
  pluginDir: string,
  importTimeoutMs?: number,
): Promise<ExternalPluginWorker[]> {
  const pluginId = basename(pluginDir);
  const eligibility = getPluginActivationEligibility(pluginDir);
  if (!eligibility.eligible) {
    throw new PluginWorkersIneligibleError(pluginId, eligibility.reason);
  }

  const workers: ExternalPluginWorker[] = [];
  for (const source of discoverExternalPluginWorkers(pluginDir)) {
    const value = await importWithTimeout<unknown>(
      source.path,
      importTimeoutMs,
    );
    if (typeof value !== "function") {
      const actual = value === undefined ? "undefined" : typeof value;
      throw new TypeError(
        `external plugin ${pluginId}: workers/${source.name} default export must be a function (got ${actual})`,
      );
    }
    workers.push({ ...source, run: value as PluginWorker });
  }
  return workers;
}
