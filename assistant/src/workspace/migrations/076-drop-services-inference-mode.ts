import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { WorkspaceMigration } from "./types.js";

/**
 * Strip the now-removed `services.inference.mode` field from existing
 * `config.json` files. The field governed the global `managed` vs `your-own`
 * routing toggle that was superseded by the `provider_connections` table. Auth
 * routing is now per-profile via the `provider_connection` reference; there is
 * no longer a schema-level field to store here.
 *
 * If `services.inference` becomes an empty object after stripping, it is left
 * as `{}` — the schema still expects the key to be present (other code walks
 * `config.services.inference`).
 *
 * Idempotent: re-running when `mode` is already absent is a no-op.
 */
export const dropServicesInferenceModeMigration: WorkspaceMigration = {
  id: "076-drop-services-inference-mode",
  description:
    "Strip services.inference.mode from config.json (mode field removed from schema)",
  run(workspaceDir: string): void {
    const configPath = join(workspaceDir, "config.json");
    if (!existsSync(configPath)) return;

    let config: Record<string, unknown>;
    try {
      const raw = JSON.parse(readFileSync(configPath, "utf-8"));
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
      config = raw as Record<string, unknown>;
    } catch {
      return;
    }

    const services = config.services;
    if (
      services === null ||
      typeof services !== "object" ||
      Array.isArray(services)
    )
      return;

    const inference = (services as Record<string, unknown>).inference;
    if (
      inference === null ||
      typeof inference !== "object" ||
      Array.isArray(inference)
    )
      return;

    const inferenceObj = inference as Record<string, unknown>;
    if (!("mode" in inferenceObj)) return;

    delete inferenceObj.mode;
    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  },
  down(_workspaceDir: string): void {
    // Forward-only: re-adding mode would reintroduce a field the schema no
    // longer recognizes.
  },
};
