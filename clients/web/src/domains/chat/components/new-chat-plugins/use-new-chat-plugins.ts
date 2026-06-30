import { useQuery } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";

import type { PluginsGetResponse } from "@/generated/daemon/types.gen";
import { installedPluginsQueryOptions } from "@/lib/installed-plugins-query";
import { useConversationStore } from "@/stores/conversation-store";

/** Generated element type for an installed plugin (`pluginsGet`). */
type InstalledPlugin = PluginsGetResponse["plugins"][number];

export interface UseNewChatPluginsResult {
  /** Installed plugins, the source for the composer's toggle pills. */
  plugins: InstalledPlugin[];
  /** Whether `name` is enabled for the active draft (default: all enabled). */
  isSelected: (name: string) => boolean;
  /** Flip `name` on/off for the active draft. */
  toggle: (name: string) => void;
}

/**
 * Data hook for the new-chat plugin pills: reads the installed plugins and
 * derives/toggles a per-draft selection backed by the conversation store's
 * `pendingDraftPlugins`.
 *
 * Selection is opt-out: with no stored entry for the active conversation id,
 * every installed plugin counts as selected. The first toggle materializes the
 * explicit set as "all installed except the toggled-off one" so the stored set
 * mirrors the all-selected default the user saw; later toggles add/remove a
 * single name. Keyed by `activeConversationId`, so unsent drafts are
 * independent (mirrors how `ComposerSettingsMenu` reads `pendingDraftProfiles`).
 */
export function useNewChatPlugins(assistantId: string): UseNewChatPluginsResult {
  const activeConversationId = useConversationStore.use.activeConversationId();
  const pendingDraftPlugins = useConversationStore.use.pendingDraftPlugins();

  const installedQuery = useQuery({
    ...installedPluginsQueryOptions(assistantId),
    enabled: Boolean(assistantId),
  });

  const plugins = useMemo(
    () => installedQuery.data?.plugins ?? [],
    [installedQuery.data?.plugins],
  );

  const selection = activeConversationId
    ? (pendingDraftPlugins.get(activeConversationId) ?? null)
    : null;

  const isSelected = useCallback(
    (name: string) => (selection ? selection.has(name) : true),
    [selection],
  );

  const toggle = useCallback(
    (name: string) => {
      if (!activeConversationId) return;
      const store = useConversationStore.getState();
      // First toggle off the all-selected default: seed the explicit set as
      // "all installed except this one" so the stored set reflects what was
      // visible, then let `togglePendingDraftPlugin` own subsequent flips.
      if (!store.pendingDraftPlugins.has(activeConversationId)) {
        const explicit = new Set(
          plugins.map((p) => p.name).filter((pluginName) => pluginName !== name),
        );
        store.setPendingDraftPlugins(activeConversationId, explicit);
        return;
      }
      store.togglePendingDraftPlugin(activeConversationId, name);
    },
    [activeConversationId, plugins],
  );

  return {
    plugins,
    isSelected,
    toggle,
  };
}
