import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";

import type { AllChatsPageProps } from "./all-chats-page";
import type { ChatsSettingsModalProps } from "@/domains/chat/components/chats-settings-modal";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { useConversationStore } from "@/stores/conversation-store";
import { useClientFeatureFlagStore } from "@/stores/client-feature-flag-store";
import { useViewerStore } from "@/stores/viewer-store";
import { routes } from "@/utils/routes";

mock.module("@/assistant/use-active-assistant-id", () => ({
  useActiveAssistantId: () =>
    useResolvedAssistantsStore.use.activeAssistantId(),
}));
mock.module("@/domains/chat/hooks/use-chats-settings", () => ({
  useChatsSettings: () => ({
    state: { status: "loading" },
    saveStatus: "idle",
    save: () => {},
    retryLoad: () => {},
  }),
}));
mock.module("@/domains/chat/components/chats-settings-modal", () => ({
  ChatsSettingsModal: ({ open, onOpenChange }: ChatsSettingsModalProps) =>
    open ? (
      <section role="dialog" aria-label="Chats Settings">
        <button onClick={() => onOpenChange(false)}>Cancel settings</button>
      </section>
    ) : null,
}));
mock.module("@/domains/chat/hooks/use-all-chats-data", () => ({
  useAllChatsData: () => ({ conversations: [], hasMore: false }),
}));
mock.module("@/domains/chat/hooks/use-all-chats-activity-refresh", () => ({
  useAllChatsActivityRefresh: () => () => () => {},
}));
mock.module("@/hooks/conversation-queries", () => ({
  useConversationGroupsQuery: () => ({ conversationGroups: [] }),
  useConversationListQuery: () => ({ conversations: [] }),
}));
mock.module("@/domains/chat/hooks/use-conversation-actions", () => ({
  useConversationActions: () => ({ handleDeleteConversation: () => {} }),
}));
mock.module("@/domains/chat/components/all-chats-live-activity", () => ({
  AllChatsLiveActivity: () => null,
}));
mock.module("@/domains/chat/pages/all-chats-page", () => ({
  AllChatsPage: ({
    onClose,
    onOpenSettings,
    listContext,
  }: AllChatsPageProps) => (
    <>
      <button onClick={onClose}>Close</button>
      <button onClick={onOpenSettings}>Chats Settings</button>
      <button onClick={() => listContext.onSelect("conv-2")}>Open chat</button>
    </>
  ),
}));

const { AllChatsPageRoute } = await import("./all-chats-page-route");
let router: ReturnType<typeof createMemoryRouter>;

beforeEach(() => {
  useResolvedAssistantsStore.setState({ activeAssistantId: "assistant-1" });
  useClientFeatureFlagStore.setState({ hydrated: true, sidebarDone: true });
  useConversationStore.getState().reset();
  useViewerStore.getState().reset();
});
afterEach(() => {
  cleanup();
  router?.dispose();
  useResolvedAssistantsStore.setState({ activeAssistantId: null });
  useClientFeatureFlagStore.setState({ hydrated: false, sidebarDone: false });
  useConversationStore.getState().reset();
  useViewerStore.getState().reset();
});

function mount(activeConversationId: string | null) {
  useConversationStore.setState({ activeConversationId });
  router = createMemoryRouter(
    [
      { path: routes.allChats, element: <AllChatsPageRoute /> },
      { path: "*", element: <div /> },
    ],
    { initialEntries: ["/previous", routes.allChats] },
  );
  return render(<RouterProvider router={router} />);
}

for (const activeId of ["conv-1", null]) {
  test(`closing replaces All Chats ${activeId ? "with the active chat" : "with the landing page"}`, async () => {
    const view = mount(activeId);
    fireEvent.click(view.getByRole("button", { name: "Close" }));
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(
        activeId ? routes.conversation(activeId) : routes.assistant,
      ),
    );
    await act(async () => {
      await router.navigate(-1);
    });
    expect(router.state.location.pathname).toBe("/previous");
  });
}

test("selecting a row keeps All Chats in the back history", async () => {
  const view = mount("conv-1");
  fireEvent.click(view.getByRole("button", { name: "Open chat" }));
  await waitFor(() =>
    expect(router.state.location.pathname).toBe(routes.conversation("conv-2")),
  );
  await act(async () => {
    await router.navigate(-1);
  });
  expect(router.state.location.pathname).toBe(routes.allChats);
});

test("settings open and cancel preserve the route and filter", async () => {
  const view = mount("conv-1");
  await act(() =>
    router.navigate(`${routes.allChats}?filter=done`, { replace: true }),
  );
  const locationKey = router.state.location.key;
  fireEvent.click(view.getByRole("button", { name: "Chats Settings" }));
  expect(view.getByRole("dialog", { name: "Chats Settings" })).toBeTruthy();
  fireEvent.click(view.getByRole("button", { name: "Cancel settings" }));
  expect(view.queryByRole("dialog")).toBeNull();
  expect(router.state.location.key).toBe(locationKey);
  expect(router.state.location.search).toBe("?filter=done");
});

test("switching assistants closes the settings session", () => {
  const view = mount("conv-1");
  fireEvent.click(view.getByRole("button", { name: "Chats Settings" }));
  expect(view.getByRole("dialog")).toBeTruthy();
  act(() =>
    useResolvedAssistantsStore.setState({ activeAssistantId: "assistant-2" }),
  );
  expect(view.queryByRole("dialog")).toBeNull();
  act(() =>
    useResolvedAssistantsStore.setState({ activeAssistantId: "assistant-1" }),
  );
  expect(view.queryByRole("dialog")).toBeNull();
});
