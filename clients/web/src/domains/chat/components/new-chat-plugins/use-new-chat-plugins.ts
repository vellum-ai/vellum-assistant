import { useQuery } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";

import { pluginsGetQueryKey } from "@/generated/daemon/@tanstack/react-query.gen";
import { pluginsGet } from "@/generated/daemon/sdk.gen";
import type { PluginsGetResponse } from "@/generated/daemon/types.gen";
import { useConversationStore } from "@/stores/conversation-store";

// The installed list (local filesystem) changes rarely, so a `staleTime`
// keeps it warm across remounts of the new-chat composer.
const INSTALLED_STALE_TIME_MS = 5 * 60 * 1000; // 5 minutes

/** Generated element type for an installed plugin (`pluginsGet`). */
type InstalledPlugin = PluginsGetResponse["plugins"][number];

export interface UseNewChatPluginsResult {
  /** Installed plugins, the source for the composer's toggle pills. */
  plugins: InstalledPlugin[];
  /** True until the installed list first resolves. */
  isLoading: boolean;
  /** Whether `name` is enabled for the active draft (default: all enabled). */
  isSelected: (name: string) => boolean;
  /** Flip `name` on/off for the active draft. */
  toggle: (name: string) => void;
  /** Whether the store holds an explicit set for the active conversation id. */
  hasExplicitSelection: boolean;
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
    queryKey: pluginsGetQueryKey({
      path: { assistant_id: assistantId },
      query: { q: undefined },
    }),
    queryFn: async ({ signal }) => {
      const result = await pluginsGet({
        path: { assistant_id: assistantId },
        query: { q: undefined },
        signal,
        throwOnError: false,
      });
      const status = result.response?.status;
      // Older daemons return 404 when the list endpoint isn't implemented
      // yet — degrade to an empty installed list.
      if (status === 404) return { plugins: [] } as PluginsGetResponse;
      if (!result.response?.ok) throw new Error("Failed to load plugins");
      return result.data ?? ({ plugins: [] } as PluginsGetResponse);
    },
    enabled: Boolean(assistantId),
    staleTime: INSTALLED_STALE_TIME_MS,
  });

  const plugins = useMemo(
    () => installedQuery.data?.plugins ?? [],
    [installedQuery.data?.plugins],
  );

  const selection = activeConversationId
    ? (pendingDraftPlugins.get(activeConversationId) ?? null)
    : null;
  const hasExplicitSelection = selection !== null;

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
    isLoading: installedQuery.isLoading,
    isSelected,
    toggle,
    hasExplicitSelection,
  };
}
