import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { WorkspaceMigration } from "./types.js";

/**
 * Fold `services.stt.mode` / `services.tts.mode` into the provider field.
 *
 * Managed speech used to be a second axis: `mode: "managed"` routed to Vellum
 * while `provider` held the untouched BYOK choice. Provider is now the only
 * axis, with `"vellum"` meaning managed, so a managed service must be rewritten
 * to `provider: "vellum"` before the new schema reads it — otherwise the
 * lingering BYOK provider would be taken at face value and a managed user would
 * silently fall back to a provider they have no key for.
 *
 * Idempotent: a config with no `mode` key is left untouched.
 */
export const speechModeToProviderMigration: WorkspaceMigration = {
  id: "130-speech-mode-to-provider",
  description:
    "Fold services.stt/tts mode into provider (managed -> provider: vellum)",
  run(workspaceDir: string): void {
    const configPath = join(workspaceDir, "config.json");
    if (!existsSync(configPath)) return;

    let config: Record<string, unknown>;
    try {
      const raw = JSON.parse(readFileSync(configPath, "utf-8"));
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
      config = raw as Record<string, unknown>;
    } catch {
      return; // Malformed JSON — skip
    }

    const services = readObj(config, "services");
    if (!services) return;

    let changed = false;
    for (const key of ["stt", "tts"]) {
      const service = readObj(services, key);
      if (!service || !("mode" in service)) continue;

      if (service.mode === "managed") {
        service.provider = "vellum";
      }
      delete service.mode;
      changed = true;
    }

    if (changed) {
      writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
    }
  },
  down(workspaceDir: string): void {
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

    const services = readObj(config, "services");
    if (!services) return;

    let changed = false;
    for (const key of ["stt", "tts"]) {
      const service = readObj(services, key);
      if (!service || "mode" in service) continue;

      // The pre-migration schema accepts provider "vellum" alongside mode
      // "managed", so the managed pair round-trips exactly. What a managed
      // service had chosen for BYOK before is not recoverable — it was
      // overwritten on the way up.
      service.mode = service.provider === "vellum" ? "managed" : "your-own";
      changed = true;
    }

    if (changed) {
      writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
    }
  },
};

// ---------------------------------------------------------------------------
// Helpers (self-contained per migration AGENTS.md)
// ---------------------------------------------------------------------------

function readObj(
  parent: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const value = parent[key];
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}
