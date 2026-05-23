import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { WorkspaceMigration } from "./types.js";

// Flip callSites.memoryRouter from { profile: "balanced" } (the shape that
// migration 087 wrote) to { profile: "cost-optimized" } so the router rides
// the workspace's cheaper/faster managed profile.
//
// The shipped default in call-site-defaults.ts also moves to cost-optimized
// in the same change; this migration is what gets existing users — who carry
// an explicit { profile: "balanced" } in their config.json — onto the new
// default. Workspaces with no memoryRouter entry already pick up the shipped
// default automatically (e.g. BYOK installs that skipped 077/087, or fresh
// installs), so this migration only touches the exact 087-seeded shape.
//
// Two skip conditions, mirroring 087:
//
//   1. BYOK / non-Anthropic workspaces. `cost-optimized` is a managed
//      Anthropic profile, which off-platform installs disable. Forcing it
//      there would make getConfiguredProvider("memoryRouter") return null
//      and silently disable memory injection. Detect via llm.default.provider.
//
//   2. User-customized memoryRouter config. If the existing entry is not
//      exactly { profile: "balanced" }, the user — or a platform overlay —
//      chose those values deliberately. Preserve any prior config.
export const memoryRouterCostOptimizedProfileMigration: WorkspaceMigration = {
  id: "089-memory-router-cost-optimized-profile",
  description:
    "Set callSites.memoryRouter to { profile: 'cost-optimized' } for workspaces still carrying the 087-seeded balanced profile",
  run(workspaceDir: string): void {
    if (process.env.VELLUM_DEFAULT_WORKSPACE_CONFIG_PATH) return;

    const configPath = join(workspaceDir, "config.json");
    if (!existsSync(configPath)) return;

    let config: Record<string, unknown> = {};
    try {
      const raw = JSON.parse(readFileSync(configPath, "utf-8"));
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
      config = raw as Record<string, unknown>;
    } catch {
      return;
    }

    const llm = readObject(config.llm);
    if (llm === null) return;

    const explicitProvider = readString(readObject(llm.default)?.provider);
    if (explicitProvider !== undefined && explicitProvider !== "anthropic") {
      return;
    }

    const callSites = readObject(llm.callSites);
    if (callSites === null) return;

    const existing = readObject(callSites.memoryRouter);
    if (existing === null || !isSeededBy087(existing)) return;

    callSites.memoryRouter = { profile: "cost-optimized" };
    llm.callSites = callSites;
    config.llm = llm;
    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  },
  down(_workspaceDir: string): void {
    // Forward-only.
  },
};

// True when the entry looks exactly like what migration 087 wrote: a single
// `profile: "balanced"` key and nothing else.
function isSeededBy087(entry: Record<string, unknown>): boolean {
  const keys = Object.keys(entry);
  return keys.length === 1 && entry.profile === "balanced";
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
