import {
  Home,
  MessageSquare,
  PanelLeft,
  Send,
  Settings,
  SquarePen,
  StepBack,
  StepForward,
  VolumeX,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type KeyboardEvent,
} from "react";

import {
  CommandPalette,
  type CommandPaletteItemData,
  type CommandPaletteSection,
} from "@/components/command-palette/command-palette";
import {
  dismissCommandPaletteWindow,
  selectCommandPaletteCommand,
} from "@/runtime/command-palette-window";
import type { VellumCommand } from "@/runtime/is-electron";

interface WindowPaletteAction extends CommandPaletteItemData {
  command: VellumCommand;
  keywords: string[];
}

const ACTIONS: WindowPaletteAction[] = [
  {
    id: "action-new-conversation",
    icon: SquarePen,
    title: "New Conversation",
    shortcutHint: "⌘N",
    command: { kind: "newConversation" },
    keywords: ["chat", "thread", "compose"],
  },
  {
    id: "action-current-conversation",
    icon: MessageSquare,
    title: "Current Conversation",
    shortcutHint: "⌘⇧N",
    command: { kind: "currentConversation" },
    keywords: ["chat", "focus", "composer"],
  },
  {
    id: "action-home",
    icon: Home,
    title: "Home",
    shortcutHint: "⌘⇧H",
    command: { kind: "home" },
    keywords: ["dashboard", "start"],
  },
  {
    id: "action-settings",
    icon: Settings,
    title: "Settings",
    shortcutHint: "⌘,",
    command: { kind: "openSettings" },
    keywords: ["preferences", "configuration"],
  },
  {
    id: "action-toggle-sidebar",
    icon: PanelLeft,
    title: "Toggle Sidebar",
    shortcutHint: "⌘\\",
    command: { kind: "sidebarToggle" },
    keywords: ["navigation", "rail"],
  },
  {
    id: "action-previous-conversation",
    icon: StepBack,
    title: "Previous Conversation",
    shortcutHint: "⌘↑",
    command: { kind: "previousConversation" },
    keywords: ["back", "chat", "thread"],
  },
  {
    id: "action-next-conversation",
    icon: StepForward,
    title: "Next Conversation",
    shortcutHint: "⌘↓",
    command: { kind: "nextConversation" },
    keywords: ["forward", "chat", "thread"],
  },
  {
    id: "action-mark-current-unread",
    icon: VolumeX,
    title: "Mark Current as Unread",
    shortcutHint: "⌘⇧U",
    command: { kind: "markCurrentUnread" },
    keywords: ["attention", "notification"],
  },
  {
    id: "action-feedback",
    icon: Send,
    title: "Share Feedback",
    command: { kind: "shareFeedback" },
    keywords: ["support", "report"],
  },
];

const normalize = (value: string): string =>
  value.toLowerCase().replace(/\s+/g, " ").trim();

const fuzzyIncludes = (haystack: string, needle: string): boolean => {
  let cursor = 0;
  for (const char of needle) {
    cursor = haystack.indexOf(char, cursor);
    if (cursor === -1) return false;
    cursor += 1;
  }
  return true;
};

const actionMatches = (action: WindowPaletteAction, query: string): boolean => {
  const normalizedQuery = normalize(query);
  if (!normalizedQuery) return true;

  const haystack = normalize(
    [action.title, action.subtitle, ...action.keywords].filter(Boolean).join(" "),
  );
  return normalizedQuery
    .split(" ")
    .every((token) => haystack.includes(token) || fuzzyIncludes(haystack, token));
};

const toPaletteItem = (action: WindowPaletteAction): CommandPaletteItemData => ({
  id: action.id,
  icon: action.icon,
  title: action.title,
  subtitle: action.subtitle,
  shortcutHint: action.shortcutHint,
});

export function CommandPaletteWindowPage() {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);

  const filteredActions = useMemo(
    () => ACTIONS.filter((action) => actionMatches(action, query)),
    [query],
  );

  useEffect(() => {
    setSelectedIndex((current) =>
      Math.min(current, Math.max(filteredActions.length - 1, 0)),
    );
  }, [filteredActions.length]);

  const sections = useMemo((): CommandPaletteSection[] => {
    if (filteredActions.length === 0) {
      return [];
    }
    return [
      {
        id: "actions",
        label: "Actions",
        items: filteredActions.map(toPaletteItem),
      },
    ];
  }, [filteredActions]);

  const selectAction = useCallback(
    (index: number) => {
      const action = filteredActions[index];
      if (!action) return;
      void selectCommandPaletteCommand(action.command);
    },
    [filteredActions],
  );

  const handleItemSelect = useCallback(
    (item: CommandPaletteItemData) => {
      const index = filteredActions.findIndex((action) => action.id === item.id);
      if (index !== -1) {
        selectAction(index);
      }
    },
    [filteredActions, selectAction],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (event.key === "k" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        void dismissCommandPaletteWindow();
        return;
      }

      switch (event.key) {
        case "ArrowDown":
          event.preventDefault();
          setSelectedIndex((current) =>
            Math.min(current + 1, Math.max(filteredActions.length - 1, 0)),
          );
          break;
        case "ArrowUp":
          event.preventDefault();
          setSelectedIndex((current) => Math.max(current - 1, 0));
          break;
        case "Enter":
          event.preventDefault();
          selectAction(selectedIndex);
          break;
        case "Escape":
          event.preventDefault();
          void dismissCommandPaletteWindow();
          break;
      }
    },
    [filteredActions.length, selectAction, selectedIndex],
  );

  return (
    <div className="h-screen w-screen bg-transparent">
      <CommandPalette
        isOpen
        surface="window"
        onClose={() => {
          void dismissCommandPaletteWindow();
        }}
        query={query}
        onQueryChange={(value) => {
          setQuery(value);
          setSelectedIndex(0);
        }}
        selectedIndex={selectedIndex}
        sections={sections}
        onItemSelect={handleItemSelect}
        onKeyDown={handleKeyDown}
      />
    </div>
  );
}
