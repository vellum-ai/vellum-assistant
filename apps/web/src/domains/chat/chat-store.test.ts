import { describe, it, expect, beforeEach } from "bun:test";

import { useChatStore } from "@/domains/chat/chat-store";

beforeEach(() => {
  useChatStore.setState({
    messages: [],
    activeConversationId: null,
    assistantId: null,
    sendMessage: async () => {},
  }, true);
});

describe("useChatStore", () => {
  it("initializes with empty messages and null identifiers", () => {
    const state = useChatStore.getState();
    expect(state.messages).toEqual([]);
    expect(state.activeConversationId).toBeNull();
    expect(state.assistantId).toBeNull();
  });

  it("initializes with noop action refs", () => {
    const state = useChatStore.getState();
    expect(typeof state.sendMessage).toBe("function");
  });

  it("setState updates only the targeted state fields", () => {
    const msg = { id: "m1", role: "user", content: "hello" } as never;
    useChatStore.setState({ messages: [msg] });

    const state = useChatStore.getState();
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]).toBe(msg);
    expect(state.activeConversationId).toBeNull();
    expect(state.assistantId).toBeNull();
  });

  it("setState updates action refs without resetting state fields", () => {
    useChatStore.setState({ assistantId: "ast-123" });

    const customSend = async () => {};
    useChatStore.setState({ sendMessage: customSend });

    const state = useChatStore.getState();
    expect(state.sendMessage).toBe(customSend);
    expect(state.assistantId).toBe("ast-123");
    expect(state.messages).toEqual([]);
  });

  it("setState replaces all fields when replace flag is true", () => {
    useChatStore.setState({ assistantId: "ast-old" });

    const fullState = {
      messages: [{ id: "m2", role: "assistant", content: "hi" } as never],
      activeConversationId: "conv-abc",
      assistantId: "ast-new",
      sendMessage: async () => {},
    };
    useChatStore.setState(fullState, true);

    const state = useChatStore.getState();
    expect(state.messages).toHaveLength(1);
    expect(state.activeConversationId).toBe("conv-abc");
    expect(state.assistantId).toBe("ast-new");
  });

  it("state updates do not affect action ref identity", () => {
    const send = async () => {};
    useChatStore.setState({ sendMessage: send });

    useChatStore.setState({ messages: [{ id: "m3" } as never] });

    expect(useChatStore.getState().sendMessage).toBe(send);
  });
});
