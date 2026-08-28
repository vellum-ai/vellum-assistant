import { MessageSquare } from "lucide-react";
import { useCallback, useLayoutEffect, useMemo, useRef } from "react";

import {
  type CommandPaletteItemData,
  type CommandPaletteSection,
} from "@/components/command-palette/command-palette";
import {
  useCommandPalette,
  type UseCommandPaletteReturn,
} from "@/components/command-palette/use-command-palette";
import { useCommandShortcut } from "@/hooks/use-command-shortcut";
import {
  buildActionsSection,
  buildServerResultSections,
} from "@/domains/chat/hooks/command-palette-utils";
import { haptic } from "@/utils/haptics";
import { routes } from "@/utils/routes";

import { formatRelativeTime } from "@/domains/chat/utils/chat";
import type { Conversation } from "@/types/conversation-types";

// ---------------------------------------------------------------------------
// Helpers — pure functions, no React state
// ---------------------------------------------------------------------------

/** Build the "Recent" section from the first 5 conversations. */
function buildRecentsSection(
  conversations: Conversation[],
): CommandPaletteSection {
  const recent = conversations.slice(0, 5);
  return {
    id: "conversations",
    label: "Recent",
    items: recent.map((conv) => ({
      id: `conv-${conv.conversationId}`,
      icon: MessageSquare,
      title: conv.title ?? "Untitled",
      subtitle: conv.lastMessageAt
        ? formatRelativeTime(conv.lastMessageAt)
        : undefined,
    })),
  };
}

// ---------------------------------------------------------------------------
// Action dispatch — maps item IDs to side effects
// ---------------------------------------------------------------------------

interface CommandPaletteActionContext {
  startNewConversation: () => void;
  switchConversation: (key: string) => void;
  navigate: (to: string | number) => void;
  activeConversationId: string | undefined;
  navigateToSettings: () => void;
}

function dispatchCommandPaletteAction(
  item: CommandPaletteItemData,
  ctx: CommandPaletteActionContext,
): void {
  switch (item.id) {
    case "action-new-conversation":
      ctx.startNewConversation();
      break;
    case "action-current-conversation":
      haptic.light();
      ctx.navigate(routes.assistant);
      break;
    case "action-settings":
      haptic.light();
      ctx.navigateToSettings();
      break;
    case "action-intelligence":
      haptic.light();
      ctx.navigate(routes.identity);
      break;
    case "action-library":
      haptic.light();
      ctx.navigate(routes.library.root);
      break;
    default:
      if (item.id.startsWith("conv-")) {
        const convKey = item.id.slice("conv-".length);
        ctx.switchConversation(convKey);
      } else if (item.id.startsWith("search-conv-")) {
        const convId = item.id.slice("search-conv-".length);
        ctx.switchConversation(convId);
      } else if (item.id.startsWith("search-schedule-")) {
        haptic.light();
        ctx.navigate(
          routes.schedules.detail(item.id.slice("search-schedule-".length)),
        );
      } else if (item.id.startsWith("search-contact-")) {
        haptic.light();
        ctx.navigate(routes.identity);
      }
      break;
  }
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

interface UseCommandPaletteSectionsParams {
  assistantId: string | null;
  assistantName: string | undefined;
  conversations: Conversation[];
  activeConversationId: string | undefined;
  startNewConversation: () => void;
  switchConversation: (key: string) => void;
  navigate: (to: string | number) => void;
  navigateToSettings: () => void;
  isOpen?: boolean;
  onClose?: () => void;
  onItemSelect?: (item: CommandPaletteItemData) => void;
}

export interface UseCommandPaletteSectionsReturn {
  commandPalette: UseCommandPaletteReturn;
  mergedSections: CommandPaletteSection[];
  handleItemSelect: (item: CommandPaletteItemData) => void;
}

export function useCommandPaletteSections({
  assistantId,
  assistantName,
  conversations,
  activeConversationId,
  startNewConversation,
  switchConversation,
  navigate,
  navigateToSettings,
  isOpen,
  onClose,
  onItemSelect,
}: UseCommandPaletteSectionsParams): UseCommandPaletteSectionsReturn {
  // Read from the host's catalog, so these follow a rebind and fill in when
  // the desktop catalog arrives after first paint.
  const newConversationShortcut = useCommandShortcut("newConversation");
  const currentConversationShortcut = useCommandShortcut("currentConversation");
  const openSettingsShortcut = useCommandShortcut("openSettings");

  // Static sections: actions + recent conversations.
  const localSections = useMemo((): CommandPaletteSection[] => {
    const actions = buildActionsSection(assistantName ?? "Assistant", {
      newConversation: newConversationShortcut,
      currentConversation: currentConversationShortcut,
      openSettings: openSettingsShortcut,
    });
    const recents = buildRecentsSection(conversations);
    return [actions, ...(recents.items.length > 0 ? [recents] : [])];
  }, [
    conversations,
    assistantName,
    newConversationShortcut,
    currentConversationShortcut,
    openSettingsShortcut,
  ]);

  // Deduplicate server results against local recents.
  const recentConversationIds = useMemo(
    () => new Set(conversations.slice(0, 5).map((c) => c.conversationId)),
    [conversations],
  );

  // Dispatch handler for a selected item.
  const handleSelect = useCallback(
    (item: CommandPaletteItemData) => {
      if (onItemSelect) {
        onItemSelect(item);
        return;
      }
      dispatchCommandPaletteAction(item, {
        startNewConversation,
        switchConversation,
        navigate,
        activeConversationId,
        navigateToSettings,
      });
    },
    [
      startNewConversation,
      switchConversation,
      navigate,
      activeConversationId,
      navigateToSettings,
      onItemSelect,
    ],
  );

  // Ref-based indirection so the index-based onSelect callback doesn't
  // re-close over every section change.
  const mergedSectionsRef = useRef<CommandPaletteSection[]>([]);
  const closeRef = useRef<() => void>(() => {});

  const handleIndexSelect = useCallback(
    (index: number) => {
      let remaining = index;
      for (const section of mergedSectionsRef.current) {
        if (remaining < section.items.length) {
          const item = section.items[remaining]!;
          handleSelect(item);
          closeRef.current();
          return;
        }
        remaining -= section.items.length;
      }
    },
    [handleSelect],
  );

  const commandPalette = useCommandPalette({
    itemCount: () =>
      mergedSectionsRef.current.reduce((acc, s) => acc + s.items.length, 0),
    onSelect: handleIndexSelect,
    assistantId,
    isOpen,
    onClose,
  });

  useLayoutEffect(() => {
    closeRef.current = commandPalette.close;
  });

  // Filter local sections by the current query.
  const filteredLocalSections = useMemo((): CommandPaletteSection[] => {
    if (!commandPalette.query.trim()) {
      return localSections;
    }
    const q = commandPalette.query.toLowerCase().trim();
    return localSections
      .map((section) => ({
        ...section,
        items: section.items.filter((item) =>
          item.title.toLowerCase().includes(q),
        ),
      }))
      .filter((section) => section.items.length > 0);
  }, [localSections, commandPalette.query]);

  // Merge local filtered sections with server search results.
  const mergedSections = useMemo((): CommandPaletteSection[] => {
    const serverSections = commandPalette.searchResults
      ? buildServerResultSections(
          commandPalette.searchResults,
          recentConversationIds,
        )
      : [];
    return [...filteredLocalSections, ...serverSections];
  }, [
    filteredLocalSections,
    commandPalette.searchResults,
    recentConversationIds,
  ]);

  // Keep the ref in sync so keyboard nav and onSelect always use the latest sections.
  useLayoutEffect(() => {
    mergedSectionsRef.current = mergedSections;
  });

  const handleItemSelect = useCallback(
    (item: CommandPaletteItemData) => {
      handleSelect(item);
      closeRef.current();
    },
    [handleSelect],
  );

  return {
    commandPalette,
    mergedSections,
    handleItemSelect,
  };
}
