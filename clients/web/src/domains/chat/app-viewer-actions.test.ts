import { afterEach, describe, expect, it, mock } from "bun:test";

import { handleAppViewerAction } from "@/domains/chat/app-viewer-actions";
import { useConversationStore } from "@/stores/conversation-store";
import { useViewerStore } from "@/stores/viewer-store";

const SAMPLE_APP = { appId: "app-1", name: "My App", html: "<h1>hi</h1>" };

function makeCtx(isMobile = false) {
  return { navigate: mock((_to: string) => {}), isMobile };
}

afterEach(() => {
  useViewerStore.getState().reset();
  useConversationStore.setState({
    activeConversationId: null,
    editingConversationId: null,
  });
});

describe("handleAppViewerAction — relay_prompt", () => {
  it("relays to the active conversation without touching the view", () => {
    useConversationStore.setState({ activeConversationId: "conv-1" });
    useViewerStore.setState({ mainView: "app-editing", openedAppState: SAMPLE_APP });
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

  it("conversationId navigates to a specific conversation", () => {
    useConversationStore.setState({ activeConversationId: "conv-1" });
    const ctx = makeCtx();

    handleAppViewerAction(ctx, "relay_prompt", {
      prompt: "your turn",
      conversationId: "battleship-conv-99",
    });

    expect(useConversationStore.getState().activeConversationId).toBe(
      "battleship-conv-99",
    );
    expect(ctx.navigate.mock.calls[0][0]).toContain(
      "/assistant/conversations/battleship-conv-99?",
    );
    expect(ctx.navigate.mock.calls[0][0]).toContain("prompt=your%20turn");
  });

  it("conversationId takes precedence over conversation 'new'", () => {
    useConversationStore.setState({ activeConversationId: "conv-1" });
    const ctx = makeCtx();

    handleAppViewerAction(ctx, "relay_prompt", {
      prompt: "go",
      conversation: "new",
      conversationId: "specific-conv",
    });

    expect(useConversationStore.getState().activeConversationId).toBe(
      "specific-conv",
    );
    expect(ctx.navigate.mock.calls[0][0]).toContain(
      "/assistant/conversations/specific-conv?",
    );
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
    useViewerStore.setState({ mainView: "app-editing", openedAppState: SAMPLE_APP });

    handleAppViewerAction(makeCtx(), "set_view", { view: "full" });

    expect(useViewerStore.getState().mainView).toBe("app");
  });

  it("'split' enters the side-by-side and binds the active conversation (desktop)", () => {
    useConversationStore.setState({ activeConversationId: "conv-1" });
    useViewerStore.setState({ mainView: "app", openedAppState: SAMPLE_APP });

    handleAppViewerAction(makeCtx(false), "set_view", { view: "split" });

    expect(useViewerStore.getState().mainView).toBe("app-editing");
    expect(useConversationStore.getState().editingConversationId).toBe("conv-1");
  });

  it("'split' is ignored on mobile", () => {
    useConversationStore.setState({ activeConversationId: "conv-1" });
    useViewerStore.setState({ mainView: "app", openedAppState: SAMPLE_APP });

    handleAppViewerAction(makeCtx(true), "set_view", { view: "split" });

    expect(useViewerStore.getState().mainView).toBe("app");
  });

  it("'split' is a no-op with no active conversation", () => {
    useConversationStore.setState({ activeConversationId: null });
    useViewerStore.setState({ mainView: "app", openedAppState: SAMPLE_APP });

    handleAppViewerAction(makeCtx(false), "set_view", { view: "split" });

    expect(useViewerStore.getState().mainView).toBe("app");
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
