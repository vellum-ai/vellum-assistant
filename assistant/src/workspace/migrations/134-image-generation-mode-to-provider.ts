import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { WorkspaceMigration } from "./types.js";

/**
 * Fold `services["image-generation"].mode` into the provider field.
 *
 * Configs written by older versions carry two axes: `mode: "managed"` routes
 * generation through the Vellum platform runtime proxy while `provider`
 * names the backend the proxy fronts (gemini or openai). The schema treats
 * `provider` as the only axis, with `"vellum"` meaning managed and the
 * backend derived from the selected model's prefix at request time, so this
 * migration rewrites every managed service to `provider: "vellum"`. There is
 * no per-provider exemption: the stored backend value under managed mode is
 * itself derived from the model on every model write, so replacing it loses
 * nothing — `model` is preserved verbatim and keeps routing the managed
 * request to the same backend.
 *
 * Idempotent: a config with no `mode` key is left untouched.
 */
export const imageGenerationModeToProviderMigration: WorkspaceMigration = {
  id: "134-image-generation-mode-to-provider",
  description:
    "Fold services.image-generation mode into provider (managed -> provider: vellum)",
  run(workspaceDir: string): void {
    const configPath = join(workspaceDir, "config.json");
    if (!existsSync(configPath)) {
      return;
    }

    let config: Record<string, unknown>;
    try {
      const raw = JSON.parse(readFileSync(configPath, "utf-8"));
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        return;
      }
      config = raw as Record<string, unknown>;
    } catch {
      return; // Malformed JSON — skip
    }

    const services = readObj(config, "services");
    if (!services) {
      return;
    }

    const service = readObj(services, "image-generation");
    if (!service || !("mode" in service)) {
      return;
    }

    if (service.mode === "managed") {
      service.provider = "vellum";
    }
    delete service.mode;

    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  },
  down(workspaceDir: string): void {
    const configPath = join(workspaceDir, "config.json");
    if (!existsSync(configPath)) {
      return;
    }

    let config: Record<string, unknown>;
    try {
      const raw = JSON.parse(readFileSync(configPath, "utf-8"));
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        return;
      }
      config = raw as Record<string, unknown>;
    } catch {
      return;
    }

    const services = readObj(config, "services");
    if (!services) {
      return;
    }

    const service = readObj(services, "image-generation");
    if (!service || "mode" in service) {
      return;
    }

    // Schemas that predate this migration accept provider "vellum" alongside
    // mode "managed", so the managed pair round-trips exactly. The backend
    // provider a managed service holds before `run()` is not recoverable —
    // `run()` overwrites it with "vellum". That value is derived from the
    // model prefix, so it re-derives on the next model write.
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
