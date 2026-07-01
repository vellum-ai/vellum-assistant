import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { conversationsByIdGetOptions } from "@/generated/daemon/@tanstack/react-query.gen";
import type {
  ConversationsByIdGetResponse,
  PluginsGetResponse,
} from "@/generated/daemon/types.gen";
import { installedPluginsQueryOptions } from "@/lib/installed-plugins-query";
import { useConversationStore } from "@/stores/conversation-store";

/** Generated element type for an installed plugin (`pluginsGet`). */
type InstalledPlugin = PluginsGetResponse["plugins"][number];

type ConversationDetail = ConversationsByIdGetResponse["conversation"];

/**
 * The persisted per-conversation plugin scope (`enabled_plugins` column,
 * migration 312) is exposed on the conversation GET response by the sibling
 * daemon PR that adds the standalone edit route. Widen the generated
 * conversation shape locally so this read-only hook compiles and behaves
 * standalone (`null`/absent = default, all installed selected); once the
 * generated type declares the field this intersection is a no-op and surfaces
 * any wire-shape drift.
 */
type ConversationWithEnabledPlugins = ConversationDetail & {
  enabledPlugins?: string[] | null;
};

/** A single installed plugin joined with its selection state for the chat. */
export interface EffectiveChatPlugin {
  name: string;
  label: string;
  icon?: string;
  selected: boolean;
}

export interface UseEffectiveChatPluginsResult {
  /** Installed plugins joined with per-chat selection, stably sorted. */
  plugins: EffectiveChatPlugin[];
  /** How many installed plugins are selected for this chat. */
  selectedCount: number;
  /** Installed plugin count (the denominator). */
  total: number;
  /** True when the chat has no explicit set — every installed plugin selected. */
  isDefault: boolean;
}

const EMPTY_RESULT: UseEffectiveChatPluginsResult = {
  plugins: [],
  selectedCount: 0,
  total: 0,
  isDefault: true,
};

/** Installed-tier ordering: alphabetical by name (mirrors the Plugins tab's `sortPlugins`). */
function sortByName(a: InstalledPlugin, b: InstalledPlugin): number {
  return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
}

/**
 * Resolves the effective plugin selection for a chat conversation by joining
 * the installed plugins against the conversation's explicit scope.
 *
 * Precedence mirrors `use-active-profile-model.ts` (existing row vs. draft):
 *
 * - **Existing/sent conversation** (a server row is loaded): the source is
 *   `conversation.enabledPlugins`. `null`/absent = default (all installed
 *   selected).
 * - **Draft** (no server row yet): the source is the composer's
 *   `pendingDraftPlugins.get(conversationId)`, with the same opt-out default as
 *   `use-new-chat-plugins.ts` (no entry = all selected).
 *
 * Read-only: this hook never mutates the store or issues a write. The returned
 * shape is memoized so pill/menu consumers don't re-render on unrelated store
 * churn.
 */
export function useEffectiveChatPlugins(
  assistantId: string | null,
  conversationId: string | undefined,
): UseEffectiveChatPluginsResult {
  const pendingDraftPlugins = useConversationStore.use.pendingDraftPlugins();

  const { data: installedData } = useQuery({
    ...installedPluginsQueryOptions(assistantId ?? ""),
    enabled: Boolean(assistantId),
  });

  const { data: convData } = useQuery({
    ...conversationsByIdGetOptions({
      path: { assistant_id: assistantId ?? "", id: conversationId ?? "" },
    }),
    enabled: Boolean(assistantId) && Boolean(conversationId),
  });

  return useMemo(() => {
    const installed = installedData?.plugins ?? [];
    if (installed.length === 0) return EMPTY_RESULT;

    // The explicit scope for this chat, or `null` when the chat is at its
    // default (every installed plugin selected). A loaded server row is the
    // source of truth; without one, fall back to the composer draft stash.
    let explicit: Set<string> | null;
    if (convData?.conversation) {
      const conversation = convData.conversation as ConversationWithEnabledPlugins;
      explicit = conversation.enabledPlugins
        ? new Set(conversation.enabledPlugins)
        : null;
    } else {
      const pending = conversationId
        ? pendingDraftPlugins.get(conversationId)
        : undefined;
      explicit = pending ?? null;
    }

    const isDefault = explicit === null;
    const plugins: EffectiveChatPlugin[] = [...installed]
      .sort(sortByName)
      .map((plugin) => ({
        name: plugin.name,
        label: plugin.name,
        selected: explicit === null ? true : explicit.has(plugin.name),
      }));

    const selectedCount = isDefault
      ? plugins.length
      : plugins.reduce((count, plugin) => count + (plugin.selected ? 1 : 0), 0);

    return {
      plugins,
      selectedCount,
      total: plugins.length,
      isDefault,
    };
  }, [installedData?.plugins, convData, conversationId, pendingDraftPlugins]);
}
