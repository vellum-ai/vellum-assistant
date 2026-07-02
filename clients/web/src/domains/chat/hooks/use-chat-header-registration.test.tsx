/**
 * Tests the top-right slot registration in `useChatHeaderRegistration`:
 * specifically that `InChatPluginPill` is mounted next to `ConversationAssetsPill`
 * only when the daemon supports per-chat plugin state. The hook's many store
 * dependencies are stubbed; the two pills are rendered as identifiable markers so
 * the captured slot node can be asserted.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render, renderHook } from "@testing-library/react";
import { createElement, type ReactNode } from "react";

const slotRef = { value: null as ReactNode };
const setTopBarRightSlot = mock((node: ReactNode) => {
  slotRef.value = node;
});
const setHeaderSupplements = mock(() => {});
mock.module("@/components/layout/chat-layout-slots-store", () => {
  const store = () => null;
  store.use = {
    setTopBarRightSlot: () => setTopBarRightSlot,
    setHeaderSupplements: () => setHeaderSupplements,
  };
  return { useChatLayoutSlotsStore: store };
});

mock.module("@/stores/resolved-assistants-store", () => {
  const store = () => null;
  store.use = { activeAssistantId: () => "asst-1" };
  return { useResolvedAssistantsStore: store };
});

mock.module("@/stores/conversation-store", () => {
  const store = () => null;
  store.use = { activeConversationId: () => "conv-1" };
  return { useConversationStore: store };
});

mock.module("@/domains/chat/transcript/use-transcript-messages", () => ({
  useTranscriptMessages: () => [],
}));

mock.module("@/domains/chat/hooks/use-active-conversation", () => ({
  useActiveConversation: () => ({ conversationId: "conv-1" }),
}));

mock.module("@/domains/chat/hooks/use-slack-conversation-display", () => ({
  useSlackConversationDisplay: () => null,
}));

mock.module("@/domains/chat/hooks/use-open-app-from-chat", () => ({
  useOpenAppFromChat: () => () => {},
}));

const supportsRef = { value: true };
mock.module("@/lib/backwards-compat/use-supports-inchat-plugin-edit", () => ({
  useSupportsInchatPluginEdit: () => supportsRef.value,
}));

mock.module("@/domains/chat/components/conversation-assets-pill", () => ({
  ConversationAssetsPill: () =>
    createElement("div", { "data-testid": "assets-pill" }),
}));

mock.module("@/domains/chat/components/inchat-plugin-pill/inchat-plugin-pill", () => ({
  InChatPluginPill: () =>
    createElement("div", { "data-testid": "plugin-pill" }),
}));

const { useChatHeaderRegistration } = await import(
  "./use-chat-header-registration"
);

function renderRegistration() {
  return renderHook(() =>
    useChatHeaderRegistration({
      assetsRefreshKey: 0,
      handleAnalyzeConversation: async () => {},
      handleForkConversationFromMenu: () => {},
      handleOpenInNewWindow: () => {},
      handleInspectConversation: () => {},
      handleCopyConversation: () => {},
      onRefresh: () => {},
    }),
  );
}

beforeEach(() => {
  supportsRef.value = true;
  slotRef.value = null;
  setTopBarRightSlot.mockClear();
});

afterEach(() => {
  cleanup();
});

describe("useChatHeaderRegistration top-right slot", () => {
  test("mounts the plugin pill beside the assets pill when supported", () => {
    supportsRef.value = true;
    renderRegistration();

    const { queryByTestId } = render(<>{slotRef.value}</>);
    expect(queryByTestId("assets-pill")).not.toBeNull();
    expect(queryByTestId("plugin-pill")).not.toBeNull();
  });

  test("omits the plugin pill on daemons that don't support it", () => {
    supportsRef.value = false;
    renderRegistration();

    const { queryByTestId } = render(<>{slotRef.value}</>);
    expect(queryByTestId("assets-pill")).not.toBeNull();
    expect(queryByTestId("plugin-pill")).toBeNull();
  });
});
