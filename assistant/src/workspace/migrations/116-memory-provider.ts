import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { WorkspaceMigration } from "./types.js";

/**
 * Pin `memory.provider` from the legacy gates so existing installs keep running
 * the same memory system after `provider` becomes the source of truth.
 *
 * Mapping (highest precedence first):
 *   - `memory.v3.live === true`        → "v3"
 *   - `memory.v2.enabled !== false`    → "v2"  (absent defaults to true, the
 *                                               `MemoryV2ConfigSchema` default,
 *                                               so the pre-migration runtime ran v2)
 *   - otherwise (v2.enabled === false) → "graph"
 *
 * The legacy keys (`memory.v2.enabled`, `memory.v3.live`) are left in place for
 * read-compat during the transition release.
 *
 * Only writes when `memory.provider` is absent or the behavior-neutral "auto"
 * sentinel. An explicit non-auto provider (a deliberate user/operator choice or
 * a prior run of this migration) is left untouched. Idempotent: a re-run finds a
 * concrete provider already set and no-ops.
 */
export const memoryProviderMigration: WorkspaceMigration = {
  id: "116-memory-provider",
  description:
    "Pin memory.provider from legacy memory.v2.enabled / memory.v3.live gates",

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

    const memory = config.memory;
    if (memory === null || typeof memory !== "object" || Array.isArray(memory))
      return;
    const memoryConfig = memory as Record<string, unknown>;

    // Respect an explicit non-auto provider — a deliberate choice or a prior
    // run of this migration. Only "auto" / absent is up for derivation.
    const current = memoryConfig.provider;
    if (current !== undefined && current !== "auto") return;

    // `memory.v2.enabled` defaults to `true` in `MemoryV2ConfigSchema`, so an
    // existing `memory` object that omits `v2.enabled` (e.g. it only carries
    // `memory.embeddings`) ran v2 before this migration. Treat an absent value
    // as the schema default — only an explicit `false` derives "graph" — so an
    // upgraded workspace is never silently switched off v2.
    const v2 = memoryConfig.v2;
    const v2EnabledRaw =
      v2 !== null && typeof v2 === "object" && !Array.isArray(v2)
        ? (v2 as Record<string, unknown>).enabled
        : undefined;
    const v2Disabled = v2EnabledRaw === false;

    const v3 = memoryConfig.v3;
    const v3Live =
      v3 !== null &&
      typeof v3 === "object" &&
      !Array.isArray(v3) &&
      (v3 as Record<string, unknown>).live === true;

    const provider = v3Live ? "v3" : v2Disabled ? "graph" : "v2";

    memoryConfig.provider = provider;
    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  },

  down(_workspaceDir: string): void {
    // Forward-only: cannot distinguish a derived provider from a user's
    // explicit choice, so reverting would risk discarding a deliberate value.
  },
};
