import { useCallback, useMemo } from "react";

import {
  CommandPalette,
  type CommandPaletteItemData,
} from "@/components/command-palette/command-palette";
import { useAssistantLifecycle } from "@/assistant/use-lifecycle";
import { useCommandPaletteSections } from "@/domains/chat/hooks/use-command-palette-sections";
import { useAppTheme } from "@/hooks/use-app-theme";
import { useClientFeatureFlagSync } from "@/hooks/use-client-feature-flag-sync";
import { useConversationListQuery } from "@/hooks/conversation-queries";
import { resolveSelectedAssistantId } from "@/assistant/selection";
import { isGatewayAuthMode } from "@/lib/auth/gateway-session";
import {
  dismissCommandPaletteWindow,
  selectCommandPaletteCommand,
} from "@/runtime/command-palette-window";
import type { VellumCommand } from "@/runtime/is-electron";
import {
  useAuthStore,
  useHasPlatformSession,
  useIsSessionInitializing,
} from "@/stores/auth-store";
import { useClientFeatureFlagStore } from "@/stores/client-feature-flag-store";
import { useOrganizationStore } from "@/stores/organization-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";

const noop = (): void => undefined;
const noopNavigate = (_to: string | number): void => undefined;

const commandForItem = (item: CommandPaletteItemData): VellumCommand | null => {
  switch (item.id) {
    case "action-new-conversation":
      return { kind: "newConversation" };
    case "action-current-conversation":
      return { kind: "currentConversation" };
    case "action-settings":
      return { kind: "openSettings" };
    case "action-library":
      return { kind: "openLibrary" };
    case "action-intelligence":
      return { kind: "openIdentity" };
    case "action-back":
      return { kind: "navigateBack" };
    case "action-forward":
      return { kind: "navigateForward" };
    case "action-zoom-in":
      return { kind: "zoomIn" };
    case "action-zoom-out":
      return { kind: "zoomOut" };
    case "action-actual-size":
      return { kind: "actualSize" };
    default:
      if (item.id.startsWith("conv-")) {
        return {
          kind: "openConversation",
          conversationId: item.id.slice("conv-".length),
        };
      }
      if (item.id.startsWith("search-conv-")) {
        return {
          kind: "openConversation",
          conversationId: item.id.slice("search-conv-".length),
        };
      }
      if (
        item.id.startsWith("search-schedule-") ||
        item.id.startsWith("search-contact-")
      ) {
        return { kind: "openIdentity" };
      }
      return null;
  }
};

export function CommandPaletteWindowPage() {
  const sessionStatus = useAuthStore.use.sessionStatus();
  const isSessionInitializing = useIsSessionInitializing();
  const hasPlatformSession = useHasPlatformSession();
  // This standalone route bypasses RootLayout; bootstrap theme + feature flags
  // so CSS custom properties resolve to the user's stored preference.
  useAppTheme();
  useClientFeatureFlagSync(!isSessionInitializing);
  useAssistantLifecycle({
    sessionStatus,
    hasPlatformSession,
  });

  const assistants = useResolvedAssistantsStore.use.assistants();
  const activeAssistantId = useResolvedAssistantsStore.use.activeAssistantId();
  const selectedAssistantId =
    useResolvedAssistantsStore.use.selectedAssistantId();
  const currentOrganizationId =
    useOrganizationStore.use.currentOrganizationId();
  const multiAssistantEnabled =
    useClientFeatureFlagStore.use.multiPlatformAssistant();
  // Mirror use-lifecycle's gating: only resolve the selection when the
  // multi-assistant flag is on; otherwise track the lifecycle's active id, so
  // the palette never binds to a stale selection the lifecycle ignored. The
  // resolver reads selectedAssistantId via getState() (non-reactive), so that
  // slice stays in the dep array as the recompute signal.
  const selectedAssistant = useMemo(
    () => {
      const selectedId =
        multiAssistantEnabled && !isGatewayAuthMode() && currentOrganizationId
          ? resolveSelectedAssistantId(currentOrganizationId)
          : activeAssistantId;
      if (!selectedId) return null;
      const entry = assistants.find((a) => a.id === selectedId);
      return entry ? { id: entry.id, name: entry.name } : null;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      multiAssistantEnabled,
      activeAssistantId,
      assistants,
      currentOrganizationId,
      selectedAssistantId,
    ],
  );
  const assistantId = selectedAssistant?.id ?? null;
  const { conversations } = useConversationListQuery(assistantId, true);

  const handleItemSelect = useCallback(
    (item: CommandPaletteItemData) => {
      const command = commandForItem(item);
      if (command) {
        void selectCommandPaletteCommand(command);
      }
    },
    [],
  );

  const { commandPalette, mergedSections, handleItemSelect: selectItem } =
    useCommandPaletteSections({
      assistantId,
      assistantName: selectedAssistant?.name,
      conversations,
      activeConversationId: undefined,
      startNewConversation: noop,
      switchConversation: noop,
      navigate: noopNavigate,
      navigateToSettings: noop,
      isOpen: true,
      onClose: () => {
        void dismissCommandPaletteWindow();
      },
      onItemSelect: handleItemSelect,
    });

  return (
    <div className="h-screen w-screen bg-transparent">
      <CommandPalette
        isOpen
        surface="window"
        onClose={commandPalette.close}
        query={commandPalette.query}
        onQueryChange={commandPalette.setQuery}
        selectedIndex={commandPalette.selectedIndex}
        sections={mergedSections}
        isSearching={commandPalette.isSearching}
        onItemSelect={selectItem}
        onKeyDown={commandPalette.handleKeyDown}
      />
    </div>
  );
}
