import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { WorkspaceMigration } from "./types.js";

// Upgrade callSites.memoryRouter from the 077-seeded
// {model: "claude-sonnet-4-6", contextWindow: {maxInputTokens: 1_000_000}}
// shape to {profile: "balanced"} so the router rides the workspace's active
// inference profile (with thinking enabled, higher effort, etc.) instead of a
// bare model pin.
//
// Two skip conditions guard against runtime regressions:
//
//   1. BYOK / non-Anthropic workspaces. `balanced` resolves to the managed
//      Anthropic connection (see seedInferenceProfiles), which off-platform
//      installs explicitly disable. Forcing `balanced` there would make
//      getConfiguredProvider("memoryRouter") return null and silently
//      disable memory injection. Detect this by inspecting llm.default.provider
//      — same heuristic migration 077 used to gate its seed.
//
//   2. User-customized memoryRouter config. If the existing entry isn't the
//      exact 077-seeded shape (and isn't already {profile: "balanced"}), the
//      user — or a platform overlay — chose those values deliberately. Match
//      077's pattern of preserving any prior config.
export const memoryRouterBalancedProfileMigration: WorkspaceMigration = {
  id: "087-memory-router-balanced-profile",
  description:
    "Set callSites.memoryRouter to { profile: 'balanced' }, dropping the seeded model and contextWindow override",
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

    const explicitProvider = readString(readObject(llm.default)?.provider);
    if (explicitProvider !== undefined && explicitProvider !== "anthropic") {
      return;
    }

    const callSites = readObject(llm.callSites) ?? {};
    const existing = readObject(callSites.memoryRouter);

    if (existing !== null && !isSeededBy077(existing)) {
      return;
    }

    callSites.memoryRouter = { profile: "balanced" };
    llm.callSites = callSites;
    config.llm = llm;
    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  },
  down(_workspaceDir: string): void {
    // Forward-only.
  },
};

// True when the entry looks exactly like what migration 077 wrote: a model pin
// of claude-sonnet-4-6 plus the 1M-token context window, and nothing else.
function isSeededBy077(entry: Record<string, unknown>): boolean {
  const keys = Object.keys(entry);
  if (keys.length !== 2) return false;
  if (entry.model !== "claude-sonnet-4-6") return false;
  const contextWindow = readObject(entry.contextWindow);
  if (contextWindow === null) return false;
  const cwKeys = Object.keys(contextWindow);
  return cwKeys.length === 1 && contextWindow.maxInputTokens === 1_000_000;
}

function readObject(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
