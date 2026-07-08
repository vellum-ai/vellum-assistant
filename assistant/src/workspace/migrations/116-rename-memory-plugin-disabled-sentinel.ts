import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import type { WorkspaceMigration } from "./types.js";

// The `memory-retrieval` and `memory-v3-shadow` default plugins were combined
// into a single `default-memory` plugin. A plugin's disabled state is a
// `.disabled` sentinel at `<workspace>/plugins/<name>/.disabled`, keyed by
// plugin name (`isPluginDisabled` in `plugins/disabled-state.ts`). Without
// carrying the sentinel forward, a user who explicitly disabled
// `default-memory-retrieval` would have memory retrieval/injection silently
// re-enabled under the new name on upgrade.
//
// Only the `default-memory-retrieval` sentinel is migrated: it gated the live
// hooks. The `default-memory-v3-shadow` plugin's hooks were no-ops (v3 ran
// through the retrieval chain), so disabling it never had an effect — migrating
// its sentinel would wrongly turn the combined memory plugin off.
//
// Both old plugin directories are then removed: now that neither name maps to a
// default plugin, a leftover stub (containing only `.disabled`) would be
// reported by `listAllPlugins()` as a bogus disabled "user" plugin with a
// missing package.json.

const OLD_RETRIEVAL = "default-memory-retrieval";
const OLD_V3_SHADOW = "default-memory-v3-shadow";
const NEW_NAME = "default-memory";

export const renameMemoryPluginDisabledSentinelMigration: WorkspaceMigration = {
  id: "116-rename-memory-plugin-disabled-sentinel",
  description:
    "Carry the disabled-state sentinel forward across the default-memory-retrieval → default-memory plugin rename and remove the defunct stub directories",
  run(workspaceDir: string): void {
    const pluginsDir = join(workspaceDir, "plugins");
    const retrievalSentinel = join(pluginsDir, OLD_RETRIEVAL, ".disabled");
    const newSentinel = join(pluginsDir, NEW_NAME, ".disabled");

    // Carry the retrieval plugin's disabled state forward (don't clobber an
    // already-migrated sentinel).
    if (existsSync(retrievalSentinel) && !existsSync(newSentinel)) {
      mkdirSync(join(pluginsDir, NEW_NAME), { recursive: true });
      copyFileSync(retrievalSentinel, newSentinel);
    }

    // Remove the now-defunct stub directories of both folded plugins. Done
    // after the copy so the disabled state is preserved first; `force: true`
    // keeps this idempotent across re-runs.
    rmSync(join(pluginsDir, OLD_RETRIEVAL), { recursive: true, force: true });
    rmSync(join(pluginsDir, OLD_V3_SHADOW), { recursive: true, force: true });
  },
  down(_workspaceDir: string): void {
    // Forward-only.
  },
};
