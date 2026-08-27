import { beforeEach, describe, expect, test } from "bun:test";

import type { ChannelReference } from "@/domains/chat/channel-sidecar/channel-reference";
import { useChannelReferenceStore } from "@/domains/chat/channel-sidecar/channel-reference-store";

function reference(overrides: Partial<ChannelReference> = {}): ChannelReference {
  return {
    messageId: "msg-1",
    conversationId: "conv-1",
    channelId: "slack",
    channelLabel: "Slack",
    snippet: "hello",
    isTruncated: false,
    ...overrides,
  };
}

describe("channel reference store", () => {
  beforeEach(() => {
    useChannelReferenceStore.setState({ reference: null });
  });

  test("holds one reference at a time", () => {
    const store = useChannelReferenceStore.getState();
    store.setReference(reference({ messageId: "msg-1" }));
    store.setReference(reference({ messageId: "msg-2" }));

    expect(useChannelReferenceStore.getState().reference?.messageId).toBe(
      "msg-2",
    );
  });

  test("toggling the staged row takes it back off the composer", () => {
    const store = useChannelReferenceStore.getState();
    store.toggleReference(reference({ messageId: "msg-1" }));
    expect(useChannelReferenceStore.getState().reference).not.toBeNull();

    store.toggleReference(reference({ messageId: "msg-1" }));
    expect(useChannelReferenceStore.getState().reference).toBeNull();
  });

  test("toggling a different row replaces rather than clears", () => {
    const store = useChannelReferenceStore.getState();
    store.toggleReference(reference({ messageId: "msg-1" }));
    store.toggleReference(reference({ messageId: "msg-2" }));

    expect(useChannelReferenceStore.getState().reference?.messageId).toBe(
      "msg-2",
    );
  });

  test("the same message id in a different conversation is a different row", () => {
    const store = useChannelReferenceStore.getState();
    store.toggleReference(reference({ conversationId: "conv-1" }));
    store.toggleReference(reference({ conversationId: "conv-2" }));

    expect(useChannelReferenceStore.getState().reference?.conversationId).toBe(
      "conv-2",
    );
  });

  test("survives reconciliation in its own conversation with the flag on", () => {
    const store = useChannelReferenceStore.getState();
    store.setReference(reference({ conversationId: "conv-1" }));

    store.reconcileReference({
      conversationId: "conv-1",
      sidecarEnabled: true,
    });
    expect(useChannelReferenceStore.getState().reference).not.toBeNull();
  });

  test("drops on reconciliation into another conversation", () => {
    const store = useChannelReferenceStore.getState();
    store.setReference(reference({ conversationId: "conv-1" }));

    store.reconcileReference({
      conversationId: "conv-2",
      sidecarEnabled: true,
    });
    expect(useChannelReferenceStore.getState().reference).toBeNull();
  });

  test("drops when there is no conversation at all", () => {
    const store = useChannelReferenceStore.getState();
    store.setReference(reference({ conversationId: "conv-1" }));

    store.reconcileReference({ conversationId: null, sidecarEnabled: true });
    expect(useChannelReferenceStore.getState().reference).toBeNull();
  });

  test("drops when the sidecar flag is off, even in its own conversation", () => {
    const store = useChannelReferenceStore.getState();
    store.setReference(reference({ conversationId: "conv-1" }));

    store.reconcileReference({
      conversationId: "conv-1",
      sidecarEnabled: false,
    });
    expect(useChannelReferenceStore.getState().reference).toBeNull();
  });
});
