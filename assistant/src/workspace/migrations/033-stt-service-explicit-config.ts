import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { WorkspaceMigration } from "./types.js";

/**
 * Materialize explicit `services.stt` configuration on disk.
 *
 * Prior to this migration the STT block was only populated at runtime via
 * Zod `.default()` values in the schema. This meant existing workspaces had
 * no `services.stt` in their `config.json` at all, making it invisible
 * to users and tooling that inspects config on disk.
 *
 * This migration writes a canonical `services.stt` block when missing or
 * partial, backfilling:
 *
 *   - `services.stt.mode`      -> `"your-own"`
 *   - `services.stt.provider`  -> `"openai-whisper"`
 *   - `services.stt.providers` -> `{ "openai-whisper": {}, "deepgram": {} }`
 *
 * It never clobbers user-defined STT values — only fills in what is missing.
 *
 * Idempotent: re-running the migration on an already-migrated config
 * produces no changes.
 */
export const sttServiceExplicitConfigMigration: WorkspaceMigration = {
  id: "033-stt-service-explicit-config",
  description:
    "Materialize explicit services.stt provider settings on disk (mode, provider, providers)",
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

    // Ensure services.stt exists as an object
    const services = ensureObj(config, "services");
    const stt = ensureObj(services, "stt");

    let changed = false;

    // Backfill mode
    if (!("mode" in stt)) {
      stt.mode = "your-own";
      changed = true;
    }

    // Backfill provider
    if (!("provider" in stt)) {
      stt.provider = "openai-whisper";
      changed = true;
    }

    // Backfill providers map and its entries
    const providers = ensureObj(stt, "providers");
    if (!("openai-whisper" in providers)) {
      providers["openai-whisper"] = {};
      changed = true;
    }
    if (!("deepgram" in providers)) {
      providers.deepgram = {};
      changed = true;
    }

    // Only write when something actually changed
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

    // Remove services.stt entirely.
    const services = config.services;
    if (services && typeof services === "object" && !Array.isArray(services)) {
      const servicesObj = services as Record<string, unknown>;
      delete servicesObj.stt;
    }

    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  },
};

// ---------------------------------------------------------------------------
// Helpers (self-contained per migration AGENTS.md)
// ---------------------------------------------------------------------------

function ensureObj(
  parent: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  if (
    !(key in parent) ||
    parent[key] == null ||
    typeof parent[key] !== "object" ||
    Array.isArray(parent[key])
  ) {
    parent[key] = {};
  }
  return parent[key] as Record<string, unknown>;
}
