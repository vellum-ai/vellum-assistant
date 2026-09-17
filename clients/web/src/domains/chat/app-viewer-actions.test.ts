import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { handleAppViewerAction } from "@/domains/chat/app-viewer-actions";
import { stubViewportAxes } from "@/hooks/viewport-axes.test-helper";
import { useConversationStore } from "@/stores/conversation-store";
import { useViewerStore } from "@/stores/viewer-store";
import {
  appEntryStateFor,
  SAMPLE_APP,
  showOpenAppRoute,
  showPath,
} from "@/stores/open-app.test-helper";
import { hasAutoSendPromptState } from "@/utils/auto-send-prompt";
import { navigateDouble } from "@/utils/conversation-navigation.test-helper";

function makeCtx(isMobile = false, state?: unknown) {
  return { navigate: navigateDouble(), isMobile, state };
}

let restoreViewport: (() => void) | undefined;

beforeEach(() => {
  restoreViewport = stubViewportAxes({
    narrow: false,
    coarsePointer: false,
  });
  showPath("/assistant");
});

afterEach(() => {
  restoreViewport?.();
  useViewerStore.getState().reset();
  useConversationStore.setState({
    activeConversationId: null,
    editingConversationId: null,
  });
});

describe("handleAppViewerAction — relay_prompt", () => {
  it("relays to the active conversation without touching the view", () => {
    useConversationStore.setState({ activeConversationId: "conv-1" });
    showOpenAppRoute({ conversationId: "conv-1", mainView: "app-editing" });
    const ctx = makeCtx(false, appEntryStateFor("conv-1"));

    handleAppViewerAction(ctx, "relay_prompt", { prompt: "hello" });

    expect(useViewerStore.getState().mainView).toBe("app-editing");
    const [url, options] = ctx.navigate.mock.calls[0];
    expect(url).toContain("/assistant/conversations/conv-1/app/app-1?");
    expect(url).toContain("prompt=hello");
    // The relay is in-app, so it may send; a bare URL would only pre-fill.
    expect(hasAutoSendPromptState(options?.state)).toBe(true);
    // It stands in for the app entry it is dispatched from, which keeps that
    // entry's recording so the close still pops.
    expect(options?.replace).toBe(true);
    expect(options?.state).toMatchObject(appEntryStateFor("conv-1"));
  });

  it("conversation 'new' starts a fresh draft and relays into it", () => {
    useConversationStore.setState({ activeConversationId: "conv-1" });
    const ctx = makeCtx(false, appEntryStateFor("conv-1"));

    handleAppViewerAction(ctx, "relay_prompt", {
      prompt: "hi",
      conversation: "new",
    });

    const newId = useConversationStore.getState().activeConversationId;
    expect(newId).toBeTruthy();
    expect(newId).not.toBe("conv-1");
    const [url, options] = ctx.navigate.mock.calls[0];
    expect(url).toContain(`/assistant/conversations/${newId}?`);
    expect(url).toContain("prompt=hi");
    expect(options?.replace).toBe(true);
    expect(hasAutoSendPromptState(options?.state)).toBe(true);
    // The entry now names another conversation, so a recording that returns to
    // the one it left cannot ride along.
    expect(options?.state).not.toHaveProperty("appEntry");
  });

  it("keeps a full-width app in the URL of the draft it relays into", () => {
    showOpenAppRoute({ conversationId: "conv-1" });
    const ctx = makeCtx();

    handleAppViewerAction(ctx, "relay_prompt", {
      prompt: "hi",
      conversation: "new",
    });

    const newId = useConversationStore.getState().activeConversationId;
    const [url] = ctx.navigate.mock.calls[0];
    expect(url).toContain(`/assistant/conversations/${newId}/app/app-1?`);
    expect(url).toContain("prompt=hi");
  });

  it("uses a unique relay token per dispatch so identical prompts re-fire", () => {
    useConversationStore.setState({ activeConversationId: "conv-1" });
    const ctx = makeCtx();

    handleAppViewerAction(ctx, "relay_prompt", { prompt: "refresh" });
    handleAppViewerAction(ctx, "relay_prompt", { prompt: "refresh" });

    const [first, firstOptions] = ctx.navigate.mock.calls[0];
    const [second, secondOptions] = ctx.navigate.mock.calls[1];
    expect(first).toContain("relay=");
    expect(first).not.toBe(second);
    // Both replace, so a repeat overwrites the relay entry rather than
    // stacking one for Back to land on.
    expect(firstOptions?.replace).toBe(true);
    expect(secondOptions?.replace).toBe(true);
  });

  it("drops when no conversation is active", () => {
    useConversationStore.setState({ activeConversationId: null });
    const ctx = makeCtx();

    handleAppViewerAction(ctx, "relay_prompt", { prompt: "nowhere" });

    expect(ctx.navigate).not.toHaveBeenCalled();
  });
});

describe("handleAppViewerAction — set_view", () => {
  it("'chat' closes the viewer and lands on the conversation URL", () => {
    useConversationStore.setState({ activeConversationId: "conv-1" });
    showOpenAppRoute({ conversationId: "conv-1" });
    const ctx = makeCtx();

    handleAppViewerAction(ctx, "set_view", { view: "chat" });

    expect(useViewerStore.getState().mainView).toBe("chat");
    expect(useViewerStore.getState().activeAppId).toBeNull();
    expect(ctx.navigate.mock.calls[0][0]).toBe(
      "/assistant/conversations/conv-1",
    );
  });

  it("'chat' pops back to the entry the open recorded", () => {
    useConversationStore.setState({ activeConversationId: "conv-1" });
    showOpenAppRoute({ conversationId: "conv-1" });
    const ctx = makeCtx(false, appEntryStateFor("conv-1"));

    handleAppViewerAction(ctx, "set_view", { view: "chat" });

    expect(ctx.navigate).toHaveBeenCalledWith(-1);
  });

  it("'chat' with no conversation starts one to land on", () => {
    useConversationStore.setState({ activeConversationId: null });
    useViewerStore.setState({
      mainView: "app",
      activeAppId: SAMPLE_APP.appId,
      openedAppState: SAMPLE_APP,
    });
    const ctx = makeCtx();

    handleAppViewerAction(ctx, "set_view", { view: "chat" });

    const newId = useConversationStore.getState().activeConversationId;
    expect(newId).toBeTruthy();
    expect(useViewerStore.getState().mainView).toBe("chat");
    expect(ctx.navigate.mock.calls[0][0]).toBe(
      `/assistant/conversations/${newId}`,
    );
  });

  it("'full' exits the side-by-side to full-width, letting the chat pane go", () => {
    useViewerStore.setState({
      mainView: "app-editing",
      openedAppState: SAMPLE_APP,
    });
    useConversationStore.setState({ editingConversationId: "conv-1" });

    handleAppViewerAction(makeCtx(), "set_view", { view: "full" });

    expect(useViewerStore.getState().mainView).toBe("app");
    expect(useConversationStore.getState().editingConversationId).toBeNull();
  });

  it("'split' enters the side-by-side and binds the active conversation (desktop)", () => {
    useConversationStore.setState({ activeConversationId: "conv-1" });
    showOpenAppRoute({ conversationId: "conv-1" });

    handleAppViewerAction(makeCtx(false), "set_view", { view: "split" });

    expect(useViewerStore.getState().mainView).toBe("app-editing");
    expect(useConversationStore.getState().editingConversationId).toBe(
      "conv-1",
    );
  });

  it("'split' is ignored on mobile", () => {
    useConversationStore.setState({ activeConversationId: "conv-1" });
    showOpenAppRoute({ conversationId: "conv-1" });

    handleAppViewerAction(makeCtx(true), "set_view", { view: "split" });

    expect(useViewerStore.getState().mainView).toBe("app");
  });

  it("'split' with no conversation starts one to put beside the app", () => {
    showOpenAppRoute({ conversationId: "conv-1" });
    useConversationStore.setState({ activeConversationId: null });
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
    showOpenAppRoute({ conversationId: "conv-1" });
    const ctx = makeCtx();

    handleAppViewerAction(ctx, "open_conversation", {
      conversationId: "target-conv",
    });

    expect(useViewerStore.getState().mainView).toBe("app-editing");
    expect(useConversationStore.getState().editingConversationId).toBe(
      "target-conv",
    );
    expect(ctx.navigate.mock.calls[0][0]).toBe(
      "/assistant/conversations/target-conv/app/app-1",
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
