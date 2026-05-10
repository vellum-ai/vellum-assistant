import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { WorkspaceMigration } from "./types.js";

/**
 * Seed `callSites.memoryRouter = { model: "claude-sonnet-4-6",
 * contextWindow: { maxInputTokens: 1000000 } }` so the per-turn memory
 * router runs on Sonnet 4.6 with the 1M context window by default.
 *
 * The router builds a numbered page index in the system prompt; a 1M
 * context window keeps every concept page reachable even on large
 * workspaces, and Sonnet 4.6 is the cheapest 1M-context Anthropic
 * model that handles the routing task well. Without this seed the
 * call site would inherit the workspace default model, which may
 * cap context at 200k and silently truncate the index for large
 * workspaces.
 *
 * Mirrors {@link seedMainAgentOpusCallsiteMigration} (050):
 *
 *   1. Existing workspace (config.json present): merge the seed into
 *      `llm.callSites` without overwriting a user-defined override.
 *   2. Fresh install (config.json absent): write a minimal starter
 *      config carrying just the seed; `loadConfig()` applies schema
 *      defaults to the in-memory config after migrations run.
 *
 * Skipped when:
 *   - `VELLUM_DEFAULT_WORKSPACE_CONFIG_PATH` is set (platform overlay wins),
 *   - the user already has `llm.callSites.memoryRouter` (any override stays),
 *   - the resolved provider is non-Anthropic (those workspaces pick their
 *     own equivalent — we don't know which OpenAI/Gemini/Ollama model the
 *     operator wants for the routing role).
 */
export const seedMemoryRouterCallsiteMigration: WorkspaceMigration = {
  id: "077-seed-memory-router-callsite",
  description:
    "Seed callSites.memoryRouter to claude-sonnet-4-6 + 1M context for Anthropic",
  run(workspaceDir: string): void {
    if (process.env.VELLUM_DEFAULT_WORKSPACE_CONFIG_PATH) return;

    const configPath = join(workspaceDir, "config.json");
    const configExisted = existsSync(configPath);

    let config: Record<string, unknown> = {};
    if (configExisted) {
      try {
        const raw = JSON.parse(readFileSync(configPath, "utf-8"));
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
        config = raw as Record<string, unknown>;
      } catch {
        return;
      }
    }

    const llm = readObject(config.llm) ?? {};
    const defaultBlock = readObject(llm.default);

    const explicitProvider = readString(defaultBlock?.provider);
    if (explicitProvider !== undefined && explicitProvider !== "anthropic") {
      return;
    }

    const callSites = readObject(llm.callSites) ?? {};
    if (readObject(callSites.memoryRouter) !== null) return;

    callSites.memoryRouter = {
      model: "claude-sonnet-4-6",
      contextWindow: { maxInputTokens: 1_000_000 },
    };
    llm.callSites = callSites;
    config.llm = llm;
    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  },
  down(_workspaceDir: string): void {
    // Forward-only: removing the seed would downgrade the router to the
    // workspace default model on every re-run, defeating the goal.
  },
};

function readObject(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
