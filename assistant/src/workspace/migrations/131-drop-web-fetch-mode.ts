import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { WorkspaceMigration } from "./types.js";

/**
 * Strip the now-removed `services.web-fetch.mode` field from existing
 * `config.json` files. Web fetch has no managed proxy, so the field never
 * governed anything — provider is the only axis — and the schema no longer
 * recognizes it.
 *
 * Purely tidying: the schema strips unknown keys, so a lingering `mode` is
 * inert at runtime. This exists so upgraded configs on disk match the schema
 * rather than carrying a dead key indefinitely.
 *
 * Idempotent: re-running when `mode` is already absent is a no-op.
 */
export const dropWebFetchModeMigration: WorkspaceMigration = {
  id: "131-drop-web-fetch-mode",
  description:
    "Strip services.web-fetch.mode from config.json (mode field removed from schema)",
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

    const webFetch = (services as Record<string, unknown>)["web-fetch"];
    if (
      webFetch === null ||
      typeof webFetch !== "object" ||
      Array.isArray(webFetch)
    )
      return;

    const webFetchObj = webFetch as Record<string, unknown>;
    if (!("mode" in webFetchObj)) return;

    delete webFetchObj.mode;
    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  },
  down(_workspaceDir: string): void {
    // Forward-only: re-adding mode would reintroduce a field the schema no
    // longer recognizes.
  },
};
