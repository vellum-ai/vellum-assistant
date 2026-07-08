import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { WorkspaceMigration } from "./types.js";

// Repoint every `provider_connection` that referenced a per-provider
// `*-managed` connection onto the single provider-agnostic `vellum`
// connection.
//
// The five managed connections (anthropic/openai/gemini/fireworks/together)
// are collapsed into one `vellum` row and are no longer seeded (a follow-up
// migration deletes the orphaned rows), so any config still pointing at them
// would fail to resolve. Managed profiles also self-heal via the boot-time
// template reconcile, but `llm.default`, per-call-site overrides, and
// user-owned copies are rewritten here.
//
// Only the connection reference changes — each entry keeps its `provider` and
// `model`, which is how the `vellum` connection recovers the upstream at
// dispatch time. Names are hardcoded: this is a frozen historical snapshot.

const LEGACY_MANAGED_CONNECTIONS = new Set([
  "anthropic-managed",
  "openai-managed",
  "gemini-managed",
  "fireworks-managed",
  "together-managed",
]);

const VELLUM_CONNECTION = "vellum";

export const repointManagedConnectionsToVellumMigration: WorkspaceMigration = {
  id: "125-repoint-managed-connections-to-vellum",
  description:
    "Repoint provider_connection from the per-provider *-managed connections to the single vellum connection",
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

    const llm = readObject(config.llm);
    if (llm === null) return;

    let changed = false;

    // llm.default
    if (repointEntry(readObject(llm.default))) changed = true;

    // llm.profiles.* (managed and user-owned alike — a repointed reference is
    // correct regardless of who owns the profile)
    const profiles = readObject(llm.profiles);
    if (profiles !== null) {
      for (const key of Object.keys(profiles)) {
        if (repointEntry(readObject(profiles[key]))) changed = true;
      }
    }

    // llm.callSites.*
    const callSites = readObject(llm.callSites);
    if (callSites !== null) {
      for (const key of Object.keys(callSites)) {
        if (repointEntry(readObject(callSites[key]))) changed = true;
      }
    }

    if (changed) {
      config.llm = llm;
      writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
    }
  },
  down(_workspaceDir: string): void {
    // Forward-only.
  },
};

/** Rewrite a single entry's provider_connection in place. Returns true if changed. */
function repointEntry(entry: Record<string, unknown> | null): boolean {
  if (entry === null) return false;
  const current = entry.provider_connection;
  if (typeof current !== "string" || !LEGACY_MANAGED_CONNECTIONS.has(current)) {
    return false;
  }
  entry.provider_connection = VELLUM_CONNECTION;
  return true;
}

function readObject(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}
