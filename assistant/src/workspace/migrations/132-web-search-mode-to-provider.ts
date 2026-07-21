import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { WorkspaceMigration } from "./types.js";

/**
 * Fold `services["web-search"].mode` into the provider field.
 *
 * Managed web search used to be a second axis: `mode: "managed"` routed to the
 * Vellum platform search proxy while `provider` held the untouched BYOK
 * choice. Provider is now the only axis, with `"vellum"` meaning managed, so a
 * managed service must be rewritten to `provider: "vellum"` before the new
 * schema reads it — otherwise the lingering BYOK provider would be taken at
 * face value and a managed user would silently fall back to a provider they
 * have no key for.
 *
 * `inference-provider-native` is the exception: it is a distinct user-facing
 * option (the inference model runs its own hosted search), so a managed
 * service on that provider keeps it verbatim rather than becoming `vellum`.
 * Its managed fallback (platform proxy when the model has no native search
 * and no user key exists) works without a `mode`.
 *
 * Idempotent: a config with no `mode` key is left untouched.
 */
export const webSearchModeToProviderMigration: WorkspaceMigration = {
  id: "132-web-search-mode-to-provider",
  description:
    "Fold services.web-search mode into provider (managed -> provider: vellum)",
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

    const service = readObj(services, "web-search");
    if (!service || !("mode" in service)) return;

    if (
      service.mode === "managed" &&
      service.provider !== "inference-provider-native"
    ) {
      service.provider = "vellum";
    }
    delete service.mode;

    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
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

    const service = readObj(services, "web-search");
    if (!service || "mode" in service) return;

    // The pre-migration schema accepts provider "vellum" alongside mode
    // "managed", so the managed pair round-trips exactly. What a managed
    // service had chosen for BYOK before is not recoverable — it was
    // overwritten on the way up. Likewise, `inference-provider-native` rolls
    // back to `your-own` even if it was previously paired with `managed`: the
    // pairing was erased when `mode` was dropped.
    service.mode = service.provider === "vellum" ? "managed" : "your-own";

    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
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
