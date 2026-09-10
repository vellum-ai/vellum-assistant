import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

import type * as MessagesApi from "@/domains/chat/api/messages";
import type * as CaptureErrorModule from "@/lib/sentry/capture-error";

const postChatMessageMock = mock<typeof MessagesApi.postChatMessage>(
  async (assistantId, conversationId) => ({
    ok: true,
    assistantId,
    conversationId: conversationId ?? "minted",
    messageId: "msg-1",
  }),
);
mock.module(
  "@/domains/chat/api/messages",
  (): Partial<typeof MessagesApi> => ({
    postChatMessage: postChatMessageMock,
  }),
);
const captureErrorMock = mock<typeof CaptureErrorModule.captureError>(() => {});
mock.module(
  "@/lib/sentry/capture-error",
  (): Partial<typeof CaptureErrorModule> => ({
    captureError: captureErrorMock,
  }),
);

import { handleAppViewerAction } from "@/domains/chat/app-viewer-actions";
import { stubViewportAxes } from "@/hooks/viewport-axes.test-helper";
import { useConversationStore } from "@/stores/conversation-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { useViewerStore } from "@/stores/viewer-store";

const SAMPLE_APP = { appId: "app-1", name: "My App", html: "<h1>hi</h1>" };

function makeCtx(isMobile = false) {
  return { navigate: mock((_to: string) => {}), isMobile };
}

function setUserActivation(isActive: boolean): void {
  Object.defineProperty(navigator, "userActivation", {
    value: { isActive, hasBeenActive: isActive },
    configurable: true,
  });
}

let restoreViewport: (() => void) | undefined;

beforeEach(() => {
  restoreViewport = stubViewportAxes({
    narrow: false,
    coarsePointer: false,
  });
  postChatMessageMock.mockClear();
  captureErrorMock.mockClear();
});

afterEach(() => {
  restoreViewport?.();
  useViewerStore.getState().reset();
  useConversationStore.setState({
    activeConversationId: null,
    editingConversationId: null,
  });
  useResolvedAssistantsStore.setState({ activeAssistantId: null });
});

describe("handleAppViewerAction — relay_prompt", () => {
  it("relays to the active conversation without touching the view", () => {
    useConversationStore.setState({ activeConversationId: "conv-1" });
    useViewerStore.setState({
      mainView: "app-editing",
      openedAppState: SAMPLE_APP,
    });
    const ctx = makeCtx();

    handleAppViewerAction(ctx, "relay_prompt", { prompt: "hello" });

    expect(useViewerStore.getState().mainView).toBe("app-editing");
    const [url] = ctx.navigate.mock.calls[0];
    expect(url).toContain("/assistant/conversations/conv-1?");
    expect(url).toContain("prompt=hello");
  });

  it("conversation 'new' starts a fresh draft and relays into it", () => {
    useConversationStore.setState({ activeConversationId: "conv-1" });
    const ctx = makeCtx();

    handleAppViewerAction(ctx, "relay_prompt", {
      prompt: "hi",
      conversation: "new",
    });

    const newId = useConversationStore.getState().activeConversationId;
    expect(newId).toBeTruthy();
    expect(newId).not.toBe("conv-1");
    expect(ctx.navigate.mock.calls[0][0]).toContain(
      `/assistant/conversations/${newId}?`,
    );
    expect(ctx.navigate.mock.calls[0][0]).toContain("prompt=hi");
  });

  it("uses a unique relay token per dispatch so identical prompts re-fire", () => {
    useConversationStore.setState({ activeConversationId: "conv-1" });
    const ctx = makeCtx();

    handleAppViewerAction(ctx, "relay_prompt", { prompt: "refresh" });
    handleAppViewerAction(ctx, "relay_prompt", { prompt: "refresh" });

    const first = ctx.navigate.mock.calls[0][0];
    const second = ctx.navigate.mock.calls[1][0];
    expect(first).toContain("relay=");
    expect(first).not.toBe(second);
  });

  it("drops when no conversation is active", () => {
    useConversationStore.setState({ activeConversationId: null });
    const ctx = makeCtx();

    handleAppViewerAction(ctx, "relay_prompt", { prompt: "nowhere" });

    expect(ctx.navigate).not.toHaveBeenCalled();
  });
});

describe("handleAppViewerAction: relay_prompt to an exact conversation", () => {
  beforeEach(() => {
    useResolvedAssistantsStore.setState({ activeAssistantId: "asst-1" });
    useConversationStore.setState({ activeConversationId: "conv-1" });
    setUserActivation(true);
  });

  it("posts the prompt into the named conversation as the user, without navigating", () => {
    const ctx = makeCtx();

    handleAppViewerAction(ctx, "relay_prompt", {
      prompt: "review this",
      conversationId: "conv-9",
    });

    expect(postChatMessageMock).toHaveBeenCalledTimes(1);
    expect(postChatMessageMock.mock.calls[0]?.slice(0, 3)).toEqual([
      "asst-1",
      "conv-9",
      "review this",
    ]);
    expect(ctx.navigate).not.toHaveBeenCalled();
    expect(useConversationStore.getState().activeConversationId).toBe("conv-1");
  });

  it("an explicit conversationId wins over conversation: 'new'", () => {
    const ctx = makeCtx();

    handleAppViewerAction(ctx, "relay_prompt", {
      prompt: "hi",
      conversation: "new",
      conversationId: "conv-9",
    });

    expect(postChatMessageMock.mock.calls[0]?.[1]).toBe("conv-9");
    expect(ctx.navigate).not.toHaveBeenCalled();
    expect(useConversationStore.getState().activeConversationId).toBe("conv-1");
  });

  it("is dropped without a transient user activation", () => {
    setUserActivation(false);
    const ctx = makeCtx();

    handleAppViewerAction(ctx, "relay_prompt", {
      prompt: "on load",
      conversationId: "conv-9",
    });

    expect(postChatMessageMock).not.toHaveBeenCalled();
    expect(ctx.navigate).not.toHaveBeenCalled();
  });

  it("is dropped when no assistant is active", () => {
    useResolvedAssistantsStore.setState({ activeAssistantId: null });

    handleAppViewerAction(makeCtx(), "relay_prompt", {
      prompt: "hi",
      conversationId: "conv-9",
    });

    expect(postChatMessageMock).not.toHaveBeenCalled();
  });

  it("reports a rejected send", async () => {
    postChatMessageMock.mockImplementationOnce(async () => ({
      ok: false,
      status: 404,
      error: {},
    }));

    handleAppViewerAction(makeCtx(), "relay_prompt", {
      prompt: "hi",
      conversationId: "conv-gone",
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(captureErrorMock).toHaveBeenCalledTimes(1);
    expect(captureErrorMock.mock.calls[0]?.[1]).toMatchObject({
      context: "app_viewer_relay_prompt",
      extra: { conversationId: "conv-gone" },
    });
  });
});

describe("handleAppViewerAction — set_view", () => {
  it("'chat' closes the app", () => {
    useViewerStore.setState({ mainView: "app", openedAppState: SAMPLE_APP });
    const ctx = makeCtx();

    handleAppViewerAction(ctx, "set_view", { view: "chat" });

    const viewer = useViewerStore.getState();
    expect(viewer.mainView).toBe("chat");
    expect(viewer.openedAppState).toBeNull();
    expect(ctx.navigate).not.toHaveBeenCalled();
  });

  it("'full' exits the side-by-side to full-width", () => {
    useViewerStore.setState({
      mainView: "app-editing",
      openedAppState: SAMPLE_APP,
    });

    handleAppViewerAction(makeCtx(), "set_view", { view: "full" });

    expect(useViewerStore.getState().mainView).toBe("app");
  });

  it("'split' enters the side-by-side and binds the active conversation (desktop)", () => {
    useConversationStore.setState({ activeConversationId: "conv-1" });
    useViewerStore.setState({ mainView: "app", openedAppState: SAMPLE_APP });

    handleAppViewerAction(makeCtx(false), "set_view", { view: "split" });

    expect(useViewerStore.getState().mainView).toBe("app-editing");
    expect(useConversationStore.getState().editingConversationId).toBe(
      "conv-1",
    );
  });

  it("'split' is ignored on mobile", () => {
    useConversationStore.setState({ activeConversationId: "conv-1" });
    useViewerStore.setState({ mainView: "app", openedAppState: SAMPLE_APP });

    handleAppViewerAction(makeCtx(true), "set_view", { view: "split" });

    expect(useViewerStore.getState().mainView).toBe("app");
  });

  it("'split' with no conversation starts one to put beside the app", () => {
    useConversationStore.setState({ activeConversationId: null });
    useViewerStore.setState({ mainView: "app", openedAppState: SAMPLE_APP });
    const ctx = makeCtx(false);

    handleAppViewerAction(ctx, "set_view", { view: "split" });

    const conversation = useConversationStore.getState();
    const newId = conversation.activeConversationId;
    expect(newId).toBeTruthy();
    expect(conversation.draftConversationIds.has(newId!)).toBe(true);
    expect(conversation.editingConversationId).toBe(newId);
    expect(useViewerStore.getState().mainView).toBe("app-editing");
    const [url] = ctx.navigate.mock.calls[0];
    expect(url).toContain(`/assistant/conversations/${newId}`);
  });
});

describe("handleAppViewerAction — open_conversation", () => {
  it("navigates to the specified conversation without sending a prompt", () => {
    useConversationStore.setState({ activeConversationId: "old-conv" });
    const ctx = makeCtx();

    handleAppViewerAction(ctx, "open_conversation", {
      conversationId: "target-conv",
    });

    expect(useConversationStore.getState().activeConversationId).toBe(
      "target-conv",
    );
    expect(ctx.navigate.mock.calls[0][0]).toContain(
      "/assistant/conversations/target-conv",
    );
    // Must NOT contain a prompt param
    expect(ctx.navigate.mock.calls[0][0]).not.toContain("prompt=");
  });

  it("enters the side-by-side so the conversation is visible beside the app", () => {
    useViewerStore.setState({
      mainView: "app",
      activeAppId: SAMPLE_APP.appId,
      openedAppState: SAMPLE_APP,
    });
    const ctx = makeCtx();

    handleAppViewerAction(ctx, "open_conversation", {
      conversationId: "target-conv",
    });

    expect(useViewerStore.getState().mainView).toBe("app-editing");
    expect(useConversationStore.getState().editingConversationId).toBe(
      "target-conv",
    );
  });

  it("is a no-op without a conversationId", () => {
    const ctx = makeCtx();

    handleAppViewerAction(ctx, "open_conversation", {});

    expect(ctx.navigate).not.toHaveBeenCalled();
  });
});

describe("handleAppViewerAction — other", () => {
  it("ignores unknown actions and empty prompts", () => {
    useConversationStore.setState({ activeConversationId: "conv-1" });
    useViewerStore.setState({ mainView: "app", openedAppState: SAMPLE_APP });
    const ctx = makeCtx();

    handleAppViewerAction(ctx, "nope", { view: "chat" });
    handleAppViewerAction(ctx, "relay_prompt", { prompt: "" });

    expect(ctx.navigate).not.toHaveBeenCalled();
    expect(useViewerStore.getState().mainView).toBe("app");
  });
});
