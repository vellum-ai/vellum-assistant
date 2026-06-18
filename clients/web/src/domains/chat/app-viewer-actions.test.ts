import { afterEach, describe, expect, it, mock } from "bun:test";

import { handleAppViewerAction } from "@/domains/chat/app-viewer-actions";
import { useConversationStore } from "@/stores/conversation-store";
import { useViewerStore } from "@/stores/viewer-store";
import { routes } from "@/utils/routes";

const SAMPLE_APP = { appId: "app-1", name: "My App", html: "<h1>hi</h1>" };

function makeCtx() {
  return { navigate: mock((_to: string) => {}) };
}

afterEach(() => {
  useViewerStore.getState().reset();
  useConversationStore.setState({ activeConversationId: null });
});

describe("handleAppViewerAction", () => {
  it("relays the prompt to the active conversation, preserving the current view", () => {
    useConversationStore.setState({ activeConversationId: "conv-1" });
    useViewerStore.setState({ mainView: "app-editing", openedAppState: SAMPLE_APP });
    const ctx = makeCtx();

    handleAppViewerAction(ctx, "relay_prompt", { prompt: "hello there" });

    // Side-by-side stays side-by-side — the relay never changes the layout.
    expect(useViewerStore.getState().mainView).toBe("app-editing");
    expect(ctx.navigate).toHaveBeenCalledWith(
      routes.conversationWithPrompt("conv-1", "hello there"),
    );
  });

  it("leaves a full-width app full-width by default", () => {
    useConversationStore.setState({ activeConversationId: "conv-1" });
    useViewerStore.setState({ mainView: "app", openedAppState: SAMPLE_APP });
    const ctx = makeCtx();

    handleAppViewerAction(ctx, "relay_prompt", { prompt: "ping" });

    expect(useViewerStore.getState().mainView).toBe("app");
    expect(ctx.navigate).toHaveBeenCalledWith(
      routes.conversationWithPrompt("conv-1", "ping"),
    );
  });

  it("closes the app before relaying when view is 'chat'", () => {
    useConversationStore.setState({ activeConversationId: "conv-1" });
    useViewerStore.setState({ mainView: "app", openedAppState: SAMPLE_APP });
    const ctx = makeCtx();

    handleAppViewerAction(ctx, "relay_prompt", {
      prompt: "take me back",
      view: "chat",
    });

    const viewer = useViewerStore.getState();
    expect(viewer.mainView).toBe("chat");
    expect(viewer.openedAppState).toBeNull();
    expect(ctx.navigate).toHaveBeenCalledWith(
      routes.conversationWithPrompt("conv-1", "take me back"),
    );
  });

  it("drops silently when there is no active conversation", () => {
    useConversationStore.setState({ activeConversationId: null });
    const ctx = makeCtx();

    handleAppViewerAction(ctx, "relay_prompt", { prompt: "nowhere" });

    expect(ctx.navigate).not.toHaveBeenCalled();
  });

  it("ignores non-relay actions and prompts without text", () => {
    useConversationStore.setState({ activeConversationId: "conv-1" });
    const ctx = makeCtx();

    handleAppViewerAction(ctx, "other_action", { prompt: "x" });
    handleAppViewerAction(ctx, "relay_prompt", { prompt: "" });
    handleAppViewerAction(ctx, "relay_prompt", {});

    expect(ctx.navigate).not.toHaveBeenCalled();
  });
});
