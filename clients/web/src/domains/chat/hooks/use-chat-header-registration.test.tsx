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

const activeConversationRef = {
  value: { conversationId: "conv-1" } as Record<string, unknown>,
};
mock.module("@/domains/chat/hooks/use-active-conversation", () => ({
  useActiveConversation: () => activeConversationRef.value,
}));

const slackDisplayRef = { value: null as Record<string, unknown> | null };
mock.module("@/domains/chat/hooks/use-slack-conversation-display", () => ({
  useSlackConversationDisplay: () => slackDisplayRef.value,
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

mock.module("@/domains/chat/components/channel-source-link-pill", () => ({
  ChannelSourceLinkPill: ({ href }: { href: string }) =>
    createElement("div", { "data-testid": "channel-source-link-pill", "data-href": href }),
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
  activeConversationRef.value = { conversationId: "conv-1" };
  slackDisplayRef.value = null;
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

  test("mounts the channel source link pill for a Slack conversation with a link", () => {
    activeConversationRef.value = {
      conversationId: "conv-1",
      originChannel: "slack",
    };
    slackDisplayRef.value = {
      displayText: "user-feedback",
      href: "https://acme.slack.com/archives/C123/p456",
      isDm: false,
      isFallback: false,
    };
    renderRegistration();

    const { queryByTestId } = render(<>{slotRef.value}</>);
    const pill = queryByTestId("channel-source-link-pill");
    expect(pill).not.toBeNull();
    expect(pill?.getAttribute("data-href")).toBe(
      "https://acme.slack.com/archives/C123/p456",
    );
  });

  test("omits the channel source link pill when the Slack display has no href", () => {
    activeConversationRef.value = {
      conversationId: "conv-1",
      originChannel: "slack",
    };
    slackDisplayRef.value = {
      displayText: "user-feedback",
      href: undefined,
      isDm: false,
      isFallback: false,
    };
    renderRegistration();

    const { queryByTestId } = render(<>{slotRef.value}</>);
    expect(queryByTestId("channel-source-link-pill")).toBeNull();
  });

  test("mounts the pill for a non-Slack channel whose binding carries a sourceLink", () => {
    activeConversationRef.value = {
      conversationId: "conv-1",
      originChannel: "telegram",
      channelBinding: {
        sourceChannel: "telegram",
        externalChatId: "123456",
        sourceLink: { webUrl: "https://t.me/c/123456/78" },
      },
    };
    renderRegistration();

    const { queryByTestId } = render(<>{slotRef.value}</>);
    const pill = queryByTestId("channel-source-link-pill");
    expect(pill).not.toBeNull();
    expect(pill?.getAttribute("data-href")).toBe("https://t.me/c/123456/78");
  });

  test("omits the channel source link pill for native conversations", () => {
    renderRegistration();

    const { queryByTestId } = render(<>{slotRef.value}</>);
    expect(queryByTestId("channel-source-link-pill")).toBeNull();
  });
});
