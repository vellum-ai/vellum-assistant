
import {
  Calendar,
  ChevronLeft,
  ChevronRight,
  Contact,
  Globe,
  LayoutGrid,
  MessageSquare,
  Monitor,
  Search as SearchIcon,
  Settings,
  SquarePen,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { useCallback, useMemo, useRef } from "react";

import {
  type CommandPaletteItemData,
  type CommandPaletteSection,
} from "@/components/command-palette/command-palette.js";
import {
  useCommandPalette,
  type UseCommandPaletteReturn,
} from "@/components/command-palette/use-command-palette.js";
import type { Conversation } from "@/domains/chat/lib/api.js";
import type { GlobalSearchResponse } from "@/domains/chat/lib/global-search.js";
import { haptic } from "@/utils/haptics.js";
import { routes } from "@/utils/routes.js";

import { formatRelativeTime } from "@/domains/chat/utils/chat-utils.js";

// ---------------------------------------------------------------------------
// Helpers — pure functions, no React state
// ---------------------------------------------------------------------------

/** Build the static "Actions" section with keyboard shortcuts. */
function buildActionsSection(assistantName: string): CommandPaletteSection {
  return {
    id: "actions",
    label: "Actions",
    items: [
      { id: "action-new-conversation", icon: SquarePen, title: "New Conversation", shortcutHint: "⌘N" },
      { id: "action-current-conversation", icon: Monitor, title: "Current Conversation", shortcutHint: "⌘⇧N" },
      { id: "action-settings", icon: Settings, title: "Settings", shortcutHint: "⌘," },
      { id: "action-library", icon: LayoutGrid, title: "Library" },
      { id: "action-intelligence", icon: Globe, title: assistantName },
      { id: "action-back", icon: ChevronLeft, title: "Back", shortcutHint: "⌘[" },
      { id: "action-forward", icon: ChevronRight, title: "Forward", shortcutHint: "⌘]" },
      { id: "action-zoom-in", icon: ZoomIn, title: "Zoom In", shortcutHint: "⌘+" },
      { id: "action-zoom-out", icon: ZoomOut, title: "Zoom Out", shortcutHint: "⌘−" },
      { id: "action-actual-size", icon: SearchIcon, title: "Actual Size", shortcutHint: "⌘0" },
    ],
  };
}

/** Build the "Recent" section from the first 5 conversations. */
function buildRecentsSection(conversations: Conversation[]): CommandPaletteSection {
  const recent = conversations.slice(0, 5);
  return {
    id: "conversations",
    label: "Recent",
    items: recent.map((conv) => ({
      id: `conv-${conv.conversationKey}`,
      icon: MessageSquare,
      title: conv.title ?? "Untitled",
      subtitle: conv.lastMessageAt ? formatRelativeTime(conv.lastMessageAt) : undefined,
    })),
  };
}

/**
 * Build sections from server search results, deduplicating conversations
 * that already appear in the local recents section.
 */
export function buildServerResultSections(
  results: GlobalSearchResponse,
  recentConversationKeys: Set<string>,
): CommandPaletteSection[] {
  const sections: CommandPaletteSection[] = [];

  const serverConvItems = results.conversations
    .filter((c) => !recentConversationKeys.has(c.id))
    .map((c) => ({
      id: `search-conv-${c.id}`,
      icon: MessageSquare,
      title: c.title ?? "Untitled",
      subtitle: c.excerpt,
    }));
  if (serverConvItems.length > 0) {
    sections.push({ id: "search-conversations", label: "Conversations", items: serverConvItems });
  }

  const scheduleItems = results.schedules.map((s) => ({
    id: `search-schedule-${s.id}`,
    icon: Calendar,
    title: s.name,
    subtitle: s.cronExpression,
  }));
  if (scheduleItems.length > 0) {
    sections.push({ id: "search-schedules", label: "Schedules", items: scheduleItems });
  }

  const contactItems = results.contacts.map((c) => ({
    id: `search-contact-${c.id}`,
    icon: Contact,
    title: c.name,
    subtitle: c.email ?? c.phone,
  }));
  if (contactItems.length > 0) {
    sections.push({ id: "search-contacts", label: "Contacts", items: contactItems });
  }

  return sections;
}

// ---------------------------------------------------------------------------
// Action dispatch — maps item IDs to side effects
// ---------------------------------------------------------------------------

interface CommandPaletteActionContext {
  startNewConversation: () => void;
  switchConversation: (key: string) => void;
  navigate: (to: string | number) => void;
  activeConversationKey: string | undefined;
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
    case "action-back":
      ctx.navigate(-1);
      break;
    case "action-forward":
      ctx.navigate(1);
      break;
    case "action-zoom-in":
      document.body.style.zoom = String(parseFloat(document.body.style.zoom || "1") + 0.1);
      break;
    case "action-zoom-out":
      document.body.style.zoom = String(Math.max(0.5, parseFloat(document.body.style.zoom || "1") - 0.1));
      break;
    case "action-actual-size":
      document.body.style.zoom = "1";
      break;
    default:
      if (item.id.startsWith("conv-")) {
        const convKey = item.id.slice("conv-".length);
        ctx.switchConversation(convKey);
      } else if (item.id.startsWith("search-conv-")) {
        const convId = item.id.slice("search-conv-".length);
        ctx.switchConversation(convId);
      } else if (
        item.id.startsWith("search-schedule-") ||
        item.id.startsWith("search-contact-")
      ) {
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
  activeConversationKey: string | undefined;
  startNewConversation: () => void;
  switchConversation: (key: string) => void;
  navigate: (to: string | number) => void;
  navigateToSettings: () => void;
}

interface UseCommandPaletteSectionsReturn {
  commandPalette: UseCommandPaletteReturn;
  mergedSections: CommandPaletteSection[];
  handleItemSelect: (item: CommandPaletteItemData) => void;
}

export function useCommandPaletteSections({
  assistantId,
  assistantName,
  conversations,
  activeConversationKey,
  startNewConversation,
  switchConversation,
  navigate,
  navigateToSettings,
}: UseCommandPaletteSectionsParams): UseCommandPaletteSectionsReturn {
  // Static sections: actions + recent conversations.
  const localSections = useMemo((): CommandPaletteSection[] => {
    const actions = buildActionsSection(assistantName ?? "Assistant");
    const recents = buildRecentsSection(conversations);
    return [actions, ...(recents.items.length > 0 ? [recents] : [])];
  }, [conversations, assistantName]);

  // Deduplicate server results against local recents.
  const recentConversationKeys = useMemo(
    () => new Set(conversations.slice(0, 5).map((c) => c.conversationKey)),
    [conversations],
  );

  // Dispatch handler for a selected item.
  const handleSelect = useCallback(
    (item: CommandPaletteItemData) => {
      dispatchCommandPaletteAction(item, {
        startNewConversation,
        switchConversation,
        navigate,
        activeConversationKey,
        navigateToSettings,
      });
    },
    [startNewConversation, switchConversation, navigate, activeConversationKey, navigateToSettings],
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
    itemCount: () => mergedSectionsRef.current.reduce((acc, s) => acc + s.items.length, 0),
    onSelect: handleIndexSelect,
    assistantId,
  });

  closeRef.current = commandPalette.close;

  // Filter local sections by the current query.
  const filteredLocalSections = useMemo((): CommandPaletteSection[] => {
    if (!commandPalette.query.trim()) {
      return localSections;
    }
    const q = commandPalette.query.toLowerCase().trim();
    return localSections
      .map((section) => ({
        ...section,
        items: section.items.filter(
          (item) => item.title.toLowerCase().includes(q),
        ),
      }))
      .filter((section) => section.items.length > 0);
  }, [localSections, commandPalette.query]);

  // Merge local filtered sections with server search results.
  const mergedSections = useMemo((): CommandPaletteSection[] => {
    const serverSections = commandPalette.searchResults
      ? buildServerResultSections(commandPalette.searchResults, recentConversationKeys)
      : [];
    return [...filteredLocalSections, ...serverSections];
  }, [filteredLocalSections, commandPalette.searchResults, recentConversationKeys]);

  // Keep the ref in sync so keyboard nav and onSelect always use the latest sections.
  mergedSectionsRef.current = mergedSections;

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
