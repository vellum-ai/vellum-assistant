import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";

const authRef = {
  sessionStatus: "authenticated" as const,
  isSessionInitializing: false,
  hasPlatformSession: true,
};
const resolvedRef = {
  assistants: [
    {
      id: "assistant-1",
      name: "Primary",
      isLocal: false,
      isPlatformHosted: true,
    },
  ],
  activeAssistantId: "assistant-1" as string | null,
  selectedAssistantId: null as string | null,
  assistantsHydrated: true,
};
const orgRef = {
  currentOrganizationId: "org-1" as string | null,
};

const useAssistantLifecycleMock = mock((_options: unknown) => undefined);
mock.module("@/assistant/use-lifecycle", () => ({
  useAssistantLifecycle: useAssistantLifecycleMock,
}));

mock.module("@/hooks/use-app-theme", () => ({
  useAppTheme: () => undefined,
}));

const useClientFeatureFlagSyncMock = mock((_enabled: boolean) => undefined);
mock.module("@/hooks/use-client-feature-flag-sync", () => ({
  useClientFeatureFlagSync: useClientFeatureFlagSyncMock,
}));

const useConversationListQueryMock = mock(
  (_assistantId: string | null, _enabled: boolean) => ({
    conversations: [
      {
        conversationId: "conv-1",
        title: "Recent conversation",
        lastMessageAt: "2026-06-10T00:00:00.000Z",
      },
    ],
    isLoading: false,
    isPending: false,
    isError: false,
    error: null,
    refetch: () => undefined,
  }),
);
mock.module("@/hooks/conversation-queries", () => ({
  useConversationListQuery: useConversationListQueryMock,
}));

const localSelectedRef = {
  value: null as { assistantId: string; name?: string } | null,
};
mock.module("@/lib/local-mode", () => ({
  getSelectedAssistant: () => localSelectedRef.value,
  getActiveAssistant: () =>
    resolvedRef.activeAssistantId
      ? { assistantId: resolvedRef.activeAssistantId }
      : undefined,
  setActiveLockfileAssistant: async () => undefined,
}));

mock.module("@/lib/auth/gateway-session", () => ({
  isGatewayAuthMode: () => false,
}));

mock.module("@/stores/client-feature-flag-store", () => ({
  useClientFeatureFlagStore: {
    use: { multiPlatformAssistant: () => true },
  },
}));

mock.module("@/stores/auth-store", () => {
  const useAuthStore = () => null;
  useAuthStore.use = {
    sessionStatus: () => authRef.sessionStatus,
  };
  return {
    useAuthStore,
    useHasPlatformSession: () => authRef.hasPlatformSession,
    useIsSessionInitializing: () => authRef.isSessionInitializing,
  };
});

mock.module("@/stores/organization-store", () => {
  const useOrganizationStore = () => null;
  useOrganizationStore.use = {
    currentOrganizationId: () => orgRef.currentOrganizationId,
  };
  useOrganizationStore.getState = () => ({
    currentOrganizationId: orgRef.currentOrganizationId,
  });
  return { useOrganizationStore };
});

mock.module("@/stores/resolved-assistants-store", () => {
  const useResolvedAssistantsStore = () => null;
  useResolvedAssistantsStore.use = {
    assistants: () => resolvedRef.assistants,
    activeAssistantId: () => resolvedRef.activeAssistantId,
    selectedAssistantId: () => resolvedRef.selectedAssistantId,
  };
  useResolvedAssistantsStore.getState = () => ({
    assistants: resolvedRef.assistants,
    selectedAssistantId: resolvedRef.selectedAssistantId,
    assistantsHydrated: resolvedRef.assistantsHydrated,
  });
  return {
    useResolvedAssistantsStore,
    assistantsValidForOrg: (
      assistants: { organizationId?: string | null; isLocal?: boolean }[],
      activeOrgId: string | null,
    ) =>
      assistants.filter(
        (a) =>
          a.isLocal ||
          a.organizationId == null ||
          a.organizationId === activeOrgId,
      ),
  };
});

const useCommandPaletteSectionsMock = mock((_params: unknown) => ({
  commandPalette: {
    close: () => undefined,
    query: "",
    setQuery: () => undefined,
    selectedIndex: 0,
    isSearching: false,
    handleKeyDown: () => undefined,
  },
  mergedSections: [
    {
      id: "actions",
      label: "Actions",
      items: [{ id: "action-new-conversation", title: "New Conversation" }],
    },
  ],
  handleItemSelect: () => undefined,
}));
mock.module("@/domains/chat/hooks/use-command-palette-sections", () => ({
  useCommandPaletteSections: useCommandPaletteSectionsMock,
}));

const { CommandPaletteWindowPage } = await import(
  "@/components/command-palette/command-palette-window-page"
);

beforeEach(() => {
  authRef.sessionStatus = "authenticated";
  authRef.isSessionInitializing = false;
  authRef.hasPlatformSession = true;
  resolvedRef.assistants = [
    {
      id: "assistant-1",
      name: "Primary",
      isLocal: false,
      isPlatformHosted: true,
    },
  ];
  resolvedRef.activeAssistantId = "assistant-1";
  resolvedRef.selectedAssistantId = null;
  resolvedRef.assistantsHydrated = true;
  orgRef.currentOrganizationId = "org-1";
  localSelectedRef.value = null;

  useAssistantLifecycleMock.mockClear();
  useClientFeatureFlagSyncMock.mockClear();
  useConversationListQueryMock.mockClear();
  useCommandPaletteSectionsMock.mockClear();
});

afterEach(() => {
  cleanup();
});

describe("CommandPaletteWindowPage", () => {
  test("bootstraps assistant context for the standalone floating window", () => {
    render(<CommandPaletteWindowPage />);

    expect(useClientFeatureFlagSyncMock).toHaveBeenCalledWith(true);
    expect(useAssistantLifecycleMock).toHaveBeenCalledWith({
      sessionStatus: "authenticated",
      hasPlatformSession: true,
    });
    expect(useConversationListQueryMock).toHaveBeenCalledWith(
      "assistant-1",
      true,
    );
  });

  test("uses the selected platform assistant while lifecycle is still resolving", () => {
    resolvedRef.assistants = [
      {
        id: "assistant-1",
        name: "Primary",
        isLocal: false,
        isPlatformHosted: true,
      },
      {
        id: "assistant-2",
        name: "Secondary",
        isLocal: false,
        isPlatformHosted: true,
      },
    ];
    resolvedRef.activeAssistantId = null;
    resolvedRef.selectedAssistantId = "assistant-2";

    render(<CommandPaletteWindowPage />);

    expect(useConversationListQueryMock).toHaveBeenCalledWith(
      "assistant-2",
      true,
    );
    expect(useCommandPaletteSectionsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        assistantId: "assistant-2",
        assistantName: "Secondary",
      }),
    );
  });
});
