import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { WorkspaceMigration } from "./types.js";

// Default profile CONTENT is code-owned (`config/default-profile-catalog.ts`)
// and resolves through the effective profile view whether or not
// `llm.profiles` carries an entry. The daemon no longer seeds default bodies
// into workspace config, so this migration strips the previously seeded
// managed entries down to thin stubs holding only the workspace-owned
// overlay fields (`source`, plus `label`/`status`/`topP` by key-presence —
// the exact whitelist the effective view reads off a managed-source entry).
//
// A same-named entry the user owns (`source !== "managed"`) is left fully
// intact — user profiles shadow the code defaults by design. Rollback to a
// pre-catalog build is safe: its seeder reconciles full template bodies back
// onto the stubs on first boot.

const DEFAULT_PROFILE_NAMES = [
  "balanced",
  "quality-optimized",
  "cost-optimized",
  "os-beta",
];

const WORKSPACE_OWNED_FIELDS = ["label", "status", "topP"];

export const stripManagedProfileBodiesMigration: WorkspaceMigration = {
  id: "126-strip-managed-profile-bodies",
  description:
    "Strip seeded managed default-profile bodies down to thin workspace-owned stubs (content is code-owned)",
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
    const profiles = readObject(llm.profiles);
    if (profiles === null) return;

    let changed = false;
    for (const name of DEFAULT_PROFILE_NAMES) {
      const entry = readObject(profiles[name]);
      if (entry === null || entry.source !== "managed") continue;

      const stub: Record<string, unknown> = { source: "managed" };
      for (const field of WORKSPACE_OWNED_FIELDS) {
        if (field in entry) {
          stub[field] = entry[field];
        }
      }

      const entryKeys = Object.keys(entry).sort();
      const stubKeys = Object.keys(stub).sort();
      const alreadyThin =
        entryKeys.length === stubKeys.length &&
        entryKeys.every((key, i) => key === stubKeys[i]);
      if (alreadyThin) continue;

      profiles[name] = stub;
      changed = true;
    }

    if (changed) {
      writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
    }
  },
  down(_workspaceDir: string): void {
    // Forward-only. A pre-catalog build's seeder reconciles full template
    // bodies back onto the stubs on its first boot.
  },
};

function readObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
