import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { WorkspaceMigration } from "./types.js";

// Flip callSites.memoryRouter from { profile: "balanced" } (the shape that
// migration 087 wrote) to the shipped cost-optimized default so the router
// rides the workspace's cheaper/faster managed profile.
//
// The migrated entry must mirror the shipped default in call-site-defaults.ts
// EXACTLY — { profile: "cost-optimized", contextWindow: { maxInputTokens:
// 1_000_000 } } — because the resolver prefers an explicit
// llm.callSites.memoryRouter entry over CALL_SITE_DEFAULTS. Writing a bare
// { profile: "cost-optimized" } would drop the 1M input window and regress
// migrated users to the profile's normal ~200k window.
//
// The shipped default in call-site-defaults.ts also moves to cost-optimized
// in the same change; this migration is what gets existing users — who carry
// an explicit { profile: "balanced" } in their config.json — onto the new
// default. Workspaces with no memoryRouter entry already pick up the shipped
// default automatically (e.g. BYOK installs that skipped 077/087, or fresh
// installs), so this migration only touches the 087-seeded balanced shape and
// the bare { profile: "cost-optimized" } shape an earlier (pre-fix) run of
// this migration may have written — the latter so those users also recover
// the 1M window.
//
// Two skip conditions, mirroring 087:
//
//   1. BYOK / non-Anthropic workspaces. `cost-optimized` is a managed
//      Anthropic profile, which off-platform installs disable. Forcing it
//      there would make getConfiguredProvider("memoryRouter") return null
//      and silently disable memory injection. Detect via llm.default.provider.
//
//   2. User-customized memoryRouter config. If the existing entry carries any
//      key beyond a bare balanced/cost-optimized profile reference, the user —
//      or a platform overlay — chose those values deliberately. Preserve them.
const MEMORY_ROUTER_COST_OPTIMIZED = {
  profile: "cost-optimized",
  contextWindow: { maxInputTokens: 1_000_000 },
} as const;

export const memoryRouterCostOptimizedProfileMigration: WorkspaceMigration = {
  id: "090-memory-router-cost-optimized-profile",
  description:
    "Set callSites.memoryRouter to the shipped cost-optimized default (with 1M context) for workspaces still carrying the 087-seeded balanced profile",
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
    if (existing === null || !needsCostOptimizedUpgrade(existing)) return;

    callSites.memoryRouter = { ...MEMORY_ROUTER_COST_OPTIMIZED };
    llm.callSites = callSites;
    config.llm = llm;
    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  },
  down(_workspaceDir: string): void {
    // Forward-only.
  },
};

// True when the entry is a bare single-key profile reference we own:
//   - { profile: "balanced" }       — what migration 087 wrote
//   - { profile: "cost-optimized" } — what a pre-fix run of THIS migration
//                                      wrote (no contextWindow), so those users
//                                      still recover the 1M window
// Any extra keys (model pins, tuning fields, an already-present contextWindow)
// mean the user/platform customized it — preserve and skip. This keeps the
// migration idempotent: once it writes the full cost-optimized + contextWindow
// shape, the two-key entry no longer matches.
function needsCostOptimizedUpgrade(entry: Record<string, unknown>): boolean {
  const keys = Object.keys(entry);
  if (keys.length !== 1) return false;
  return entry.profile === "balanced" || entry.profile === "cost-optimized";
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
