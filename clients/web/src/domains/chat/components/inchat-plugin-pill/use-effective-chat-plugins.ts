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
 * Conversation detail shape widened with the per-chat plugin scope:
 * `enabledPlugins` is `null`/absent when the chat has no restriction (every
 * installed plugin selected), or a `string[]` scoping it to a subset.
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
  /**
   * True once the chat's scope is known (row loaded, confirmed absent, or a
   * draft context). False while an existing chat's detail is still loading — so
   * consumers can wait rather than show the default/all-selected scope.
   */
  isResolved: boolean;
}

const EMPTY_RESULT: UseEffectiveChatPluginsResult = {
  plugins: [],
  selectedCount: 0,
  total: 0,
  isDefault: true,
  isResolved: true,
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

  const convEnabled = Boolean(assistantId) && Boolean(conversationId);
  const convQuery = useQuery({
    ...conversationsByIdGetOptions({
      path: { assistant_id: assistantId ?? "", id: conversationId ?? "" },
    }),
    enabled: convEnabled,
  });
  const convData = convQuery.data;
  const convIsError = convQuery.isError;
  const convIsSuccess = convQuery.isSuccess;

  return useMemo(() => {
    const installed = installedData?.plugins ?? [];
    if (installed.length === 0) {
      return EMPTY_RESULT;
    }

    const conversation = convData?.conversation as
      | ConversationWithEnabledPlugins
      | undefined;

    // The chat's scope is known once the conversation detail settles: a loaded
    // row, a confirmed 404/no-row, or a draft context (no conversationId /
    // disabled query). While an existing chat's detail is still pending, the
    // scope is unknown — `isResolved` is false so the pill waits instead of
    // showing the draft/default (all plugins) for an explicitly scoped chat.
    const rowKnownAbsent =
      !convEnabled || convIsError || (convIsSuccess && !conversation);
    const isResolved = Boolean(conversation) || rowKnownAbsent;

    // The explicit scope for this chat, or `null` at its default (every
    // installed plugin selected). A loaded row is the source of truth; when the
    // row is known absent, fall back to the composer draft stash.
    let explicit: Set<string> | null;
    if (conversation) {
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
      isResolved,
    };
  }, [
    installedData?.plugins,
    convData,
    convIsError,
    convIsSuccess,
    convEnabled,
    conversationId,
    pendingDraftPlugins,
  ]);
}
