import { memoryPersistenceHooks } from "./persistence-hooks.js";
import { registerMemoryPersistenceHooks } from "./persistence-lifecycle-seam.js";

/**
 * Registration entry point for the memory plugin's persistence-lifecycle seam
 * (`persistence-lifecycle-seam.ts`): wires the plugin's handler implementation
 * (`persistence-hooks.ts`) into the seam's slot.
 *
 * Kept separate from the seam module on purpose: this module transitively
 * imports persistence (through the handler implementation) while persistence
 * imports the seam, so folding the two together would close an import cycle.
 */

/**
 * Install the memory feature's persistence-lifecycle handlers into the seam.
 * `bootstrapPlugins` calls this before the per-plugin init loop so the seam is
 * wired up front (the standalone memory jobs worker, which has no plugin
 * bootstrap, calls it directly). The seam holds a single handler set, so this
 * replaces any prior registration.
 */
export function registerDefaultPluginPersistenceHooks(): void {
  registerMemoryPersistenceHooks(memoryPersistenceHooks);
}
