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
import { useConversationStore } from "@/stores/conversation-store";
import { useClientFeatureFlagStore } from "@/stores/client-feature-flag-store";
import { useViewerStore } from "@/stores/viewer-store";
import { routes } from "@/utils/routes";

mock.module("@/assistant/use-active-assistant-id", () => ({
  useActiveAssistantId: () => "assistant-1",
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
  AllChatsPage: ({ onClose, listContext }: AllChatsPageProps) => (
    <>
      <button onClick={onClose}>Close</button>
      <button onClick={() => listContext.onSelect("conv-2")}>Open chat</button>
    </>
  ),
}));

const { AllChatsPageRoute } = await import("./all-chats-page-route");
let router: ReturnType<typeof createMemoryRouter>;

beforeEach(() => {
  useClientFeatureFlagStore.setState({ hydrated: true, sidebarDone: true });
  useConversationStore.getState().reset();
  useViewerStore.getState().reset();
});
afterEach(() => {
  cleanup();
  router?.dispose();
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
