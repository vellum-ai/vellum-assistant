import { isPluginDisabled } from "../../disabled-state.js";
import memoryPkg from "./package.json" with { type: "json" };
import { memoryPersistenceHooks } from "./persistence-hooks.js";
import {
  type MemoryPersistenceHooks,
  registerMemoryPersistenceHooks,
} from "./persistence-lifecycle-seam.js";

/**
 * Registration entry point for the memory plugin's persistence-lifecycle seam
 * (`persistence-lifecycle-seam.ts`): wires the plugin's handler implementation
 * (`persistence-hooks.ts`) into the seam's slot, wrapped in the disabled-state
 * guard.
 *
 * Kept separate from the seam module on purpose: this module transitively
 * imports persistence (through the handler implementation) while persistence
 * imports the seam, so folding the two together would close an import cycle.
 */

/**
 * Wrap the plugin's persistence hooks so its ACTIVE side-effect hooks no-op while
 * the plugin is disabled (`assistant plugins disable <name>`), mirroring the
 * read-time disabled-state filtering the injector/hook/job-handler/tool surfaces
 * apply. The sentinel is checked per call, so enable/disable takes effect on the
 * next write without a daemon restart. CLEANUP hooks (`onConversationWiped`,
 * `onConversationDeleted`, `onMessagesDeleted`, `onAllConversationsCleared`,
 * `onWorkerStartup`) are intentionally NOT gated — they must run even when the
 * plugin is disabled so state created while it was enabled is not orphaned.
 */
export function guardPersistenceHooksByDisabledState(
  pluginName: string,
  hooks: MemoryPersistenceHooks,
): MemoryPersistenceHooks {
  return {
    onMessagePersisted(event) {
      if (isPluginDisabled(pluginName)) return;
      return hooks.onMessagePersisted(event);
    },
    onConversationForked(event) {
      if (isPluginDisabled(pluginName)) return;
      return hooks.onConversationForked(event);
    },
    // Gated like the active side effects above: a disabled plugin reports an
    // empty buffer, so the maintenance scheduler treats it as "no buffered
    // work" and skips consolidation — matching how disabled injectors/hooks go
    // inert.
    countMemoryBufferLines() {
      if (isPluginDisabled(pluginName)) return 0;
      return hooks.countMemoryBufferLines();
    },
    // Gated the same way: a disabled plugin reports an empty PKB buffer, so
    // the maintenance scheduler skips scheduled filing.
    hasPkbBufferContent() {
      if (isPluginDisabled(pluginName)) return false;
      return hooks.hasPkbBufferContent();
    },
    // Cleanup hooks are NOT gated on disabled-state: they must run even while
    // the plugin is disabled, or jobs/conversations created while it was
    // enabled would be orphaned.
    onConversationWiped(conversationId) {
      return hooks.onConversationWiped(conversationId);
    },
    onConversationDeleted(conversationId) {
      return hooks.onConversationDeleted(conversationId);
    },
    onMessagesDeleted(messageIds) {
      return hooks.onMessagesDeleted(messageIds);
    },
    onAllConversationsCleared() {
      return hooks.onAllConversationsCleared();
    },
    onWorkerStartup() {
      return hooks.onWorkerStartup();
    },
  };
}

/**
 * Install the memory feature's persistence-lifecycle handlers into the seam.
 * `bootstrapPlugins` calls this before the per-plugin init loop so the seam is
 * wired up front (the standalone memory jobs worker, which has no plugin
 * bootstrap, calls it directly); the handlers are guarded by
 * {@link guardPersistenceHooksByDisabledState} so a disabled memory plugin
 * drives no persistence side effects and re-enabling it takes effect on the
 * next write. The seam holds a single handler set, so this replaces any prior
 * registration.
 */
export function registerDefaultPluginPersistenceHooks(): void {
  registerMemoryPersistenceHooks(
    guardPersistenceHooksByDisabledState(
      memoryPkg.name,
      memoryPersistenceHooks,
    ),
  );
}
