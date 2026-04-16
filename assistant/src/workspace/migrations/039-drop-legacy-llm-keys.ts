import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { WorkspaceMigration } from "./types.js";

/**
 * Strip the now-removed legacy LLM-related keys from existing `config.json`
 * files. PR 19 of the unify-llm-callsites plan removed these keys from
 * `AssistantConfigSchema`; Zod silently strips unknown fields when re-parsing,
 * but the keys would otherwise persist on disk forever and re-appear in any
 * exported config snapshot. Erasing them keeps `config.json` lean and matches
 * the schema that the in-memory loader sees.
 *
 * Keys removed:
 *   - Top level: `maxTokens`, `effort`, `speed`, `thinking`, `contextWindow`,
 *     `pricingOverrides`.
 *   - `services.inference.{provider, model}` (the `mode` field stays — it
 *     governs `managed` vs `your-own` routing, which is orthogonal to LLM
 *     model selection).
 *   - `heartbeat.speed`, `filing.speed`.
 *   - `analysis.modelIntent`, `analysis.modelOverride`.
 *   - `memory.summarization.modelIntent`.
 *   - `notifications.decisionModelIntent`.
 *   - `ui.greetingModelIntent`.
 *   - `calls.model`.
 *   - `workspaceGit.commitMessageLLM.{maxTokens, temperature,
 *     useConfiguredProvider, providerFastModelOverrides}`.
 *
 * Preconditions: this migration depends on
 * `038-unify-llm-callsite-configs` having already populated `llm.default` /
 * `llm.callSites` / `llm.pricingOverrides` from these legacy keys. The
 * registry guarantees ordering.
 *
 * Idempotency: each delete is wrapped in a key-exists check so re-runs are
 * no-ops. Empty objects are left in place rather than recursively pruned —
 * that matches Zod's default behavior of treating an absent value the same
 * as an empty `{}` for nested schemas.
 */
export const dropLegacyLlmKeysMigration: WorkspaceMigration = {
  id: "039-drop-legacy-llm-keys",
  description:
    "Strip deprecated scattered LLM-related keys from config.json (post-PR-19 cleanup)",
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

    let mutated = false;

    for (const key of [
      "maxTokens",
      "effort",
      "speed",
      "thinking",
      "contextWindow",
      "pricingOverrides",
    ]) {
      if (key in config) {
        delete config[key];
        mutated = true;
      }
    }

    const services = readObject(config.services);
    if (services !== null) {
      const inference = readObject(services.inference);
      if (inference !== null) {
        for (const key of ["provider", "model"]) {
          if (key in inference) {
            delete inference[key];
            mutated = true;
          }
        }
      }
    }

    const heartbeat = readObject(config.heartbeat);
    if (heartbeat !== null && "speed" in heartbeat) {
      delete heartbeat.speed;
      mutated = true;
    }

    const filing = readObject(config.filing);
    if (filing !== null && "speed" in filing) {
      delete filing.speed;
      mutated = true;
    }

    const analysis = readObject(config.analysis);
    if (analysis !== null) {
      for (const key of ["modelIntent", "modelOverride"]) {
        if (key in analysis) {
          delete analysis[key];
          mutated = true;
        }
      }
    }

    const memory = readObject(config.memory);
    if (memory !== null) {
      const summarization = readObject(memory.summarization);
      if (summarization !== null && "modelIntent" in summarization) {
        delete summarization.modelIntent;
        mutated = true;
      }
    }

    const notifications = readObject(config.notifications);
    if (notifications !== null && "decisionModelIntent" in notifications) {
      delete notifications.decisionModelIntent;
      mutated = true;
    }

    const ui = readObject(config.ui);
    if (ui !== null && "greetingModelIntent" in ui) {
      delete ui.greetingModelIntent;
      mutated = true;
    }

    const calls = readObject(config.calls);
    if (calls !== null && "model" in calls) {
      delete calls.model;
      mutated = true;
    }

    const workspaceGit = readObject(config.workspaceGit);
    if (workspaceGit !== null) {
      const commitMessageLLM = readObject(workspaceGit.commitMessageLLM);
      if (commitMessageLLM !== null) {
        for (const key of [
          "maxTokens",
          "temperature",
          "useConfiguredProvider",
          "providerFastModelOverrides",
        ]) {
          if (key in commitMessageLLM) {
            delete commitMessageLLM[key];
            mutated = true;
          }
        }
      }
    }

    if (!mutated) return;

    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  },
  /**
   * Forward-only. Restoring the deleted keys would re-introduce schema-validation
   * warnings and have no runtime effect — every reader migrated to `llm.default`
   * / `llm.callSites` in PR 19.
   */
  down(_workspaceDir: string): void {
    // no-op
  },
};

function readObject(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}
