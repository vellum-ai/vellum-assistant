/**
 * Host-side coverage for the sandbox context bridge.
 *
 * The behaviour worth pinning is that `vellum_context_request` is answered
 * from the host's live selection rather than from anything captured when the
 * app mounted, and that the answer still passes the frame and source checks
 * every other sandbox message passes.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type { RefObject } from "react";

import { useSandboxFetchProxy } from "@/hooks/use-sandbox-fetch-proxy";
import { useConversationStore } from "@/stores/conversation-store";

const FRAME_ID = "app-under-test";
const ASSISTANT_ID = "assistant-1";

let iframe: HTMLIFrameElement | undefined;
let replies: Record<string, unknown>[];

/** The mounted frame, or a failed test rather than a confusing null deref. */
function mountedFrame(): HTMLIFrameElement {
  if (!iframe) {
    throw new Error("expected the proxy to have been mounted");
  }
  return iframe;
}

/** Mount the proxy against a real iframe whose replies are recorded. */
function mountProxy(options?: { enabled?: boolean }) {
  const frame = document.createElement("iframe");
  document.body.appendChild(frame);
  iframe = frame;
  const contentWindow = frame.contentWindow;
  if (!contentWindow) {
    throw new Error("expected the test iframe to expose a contentWindow");
  }
  // Record what the host posts back instead of letting it cross a real frame
  // boundary, which happy-dom delivers asynchronously and to nobody here.
  Object.defineProperty(contentWindow, "postMessage", {
    value: (message: Record<string, unknown>) => {
      replies.push(message);
    },
    configurable: true,
    writable: true,
  });
  // One stable ref and one stable options object: the hook keys its effect on
  // both, so fresh identities per render would re-register the listener and
  // hide a genuine re-registration if one ever appeared.
  const iframeRef: RefObject<HTMLIFrameElement | null> = { current: frame };
  const proxyOptions = {
    frameId: FRAME_ID,
    assistantId: ASSISTANT_ID,
    ...(options?.enabled === undefined ? {} : { enabled: options.enabled }),
  };
  return renderHook(() => useSandboxFetchProxy(iframeRef, proxyOptions));
}

/**
 * Deliver a context request as the sandboxed frame would send it.
 *
 * `source` is readonly on the constructed event and happy-dom does not honour
 * it from the init dict, so it is defined onto the event the way the other
 * sandbox message tests do it.
 */
function requestContext(
  callId: string,
  overrides?: { frameId?: string; source?: unknown },
): void {
  const event = new MessageEvent("message", {
    data: {
      type: "vellum_context_request",
      frameId: overrides?.frameId ?? FRAME_ID,
      callId,
    },
  });
  const source =
    overrides && "source" in overrides
      ? overrides.source
      : mountedFrame().contentWindow;
  Object.defineProperty(event, "source", { value: source });
  window.dispatchEvent(event);
}

beforeEach(() => {
  replies = [];
  iframe = undefined;
  useConversationStore.setState({
    activeConversationId: null,
    editingConversationId: null,
  });
});

afterEach(() => {
  cleanup();
  iframe?.remove();
  iframe = undefined;
  useConversationStore.setState({
    activeConversationId: null,
    editingConversationId: null,
  });
});

describe("useSandboxFetchProxy host context", () => {
  test("answers with the host's current conversation selection", async () => {
    useConversationStore.setState({
      activeConversationId: "conv-active",
      editingConversationId: "conv-editing",
    });
    mountProxy();

    requestContext("c1");

    await waitFor(() => expect(replies).toHaveLength(1));
    expect(replies[0]).toEqual({
      type: "vellum_context_response",
      callId: "c1",
      activeConversationId: "conv-active",
      editingConversationId: "conv-editing",
    });
  });

  test("reports null when the host has no conversation selected", async () => {
    mountProxy();

    requestContext("c1");

    await waitFor(() => expect(replies).toHaveLength(1));
    expect(replies[0]).toMatchObject({
      callId: "c1",
      activeConversationId: null,
      editingConversationId: null,
    });
  });

  test("reports null for the editing slot while a conversation is active", async () => {
    useConversationStore.setState({ activeConversationId: "conv-active" });
    mountProxy();

    requestContext("c1");

    await waitFor(() => expect(replies).toHaveLength(1));
    expect(replies[0]).toMatchObject({
      activeConversationId: "conv-active",
      editingConversationId: null,
    });
  });

  test("reads the selection at request time, not at mount time", async () => {
    useConversationStore.setState({ activeConversationId: "conv-first" });
    mountProxy();

    requestContext("c1");
    await waitFor(() => expect(replies).toHaveLength(1));
    expect(replies[0]).toMatchObject({ activeConversationId: "conv-first" });

    // The same mounted app, after the host switches conversations. A value
    // captured at mount would still answer "conv-first" here.
    useConversationStore.setState({ activeConversationId: "conv-second" });

    requestContext("c2");
    await waitFor(() => expect(replies).toHaveLength(2));
    expect(replies[1]).toMatchObject({
      callId: "c2",
      activeConversationId: "conv-second",
    });
  });

  test("follows a switch into and back out of having no conversation", async () => {
    useConversationStore.setState({ activeConversationId: "conv-first" });
    mountProxy();

    useConversationStore.setState({ activeConversationId: null });
    requestContext("c1");
    await waitFor(() => expect(replies).toHaveLength(1));
    expect(replies[0]).toMatchObject({ activeConversationId: null });

    useConversationStore.setState({ activeConversationId: "conv-third" });
    requestContext("c2");
    await waitFor(() => expect(replies).toHaveLength(2));
    expect(replies[1]).toMatchObject({ activeConversationId: "conv-third" });
  });

  test("ignores a request carrying another frame's id", async () => {
    useConversationStore.setState({ activeConversationId: "conv-active" });
    mountProxy();

    requestContext("c1", { frameId: "some-other-frame" });

    // Nothing to wait for: assert the handler stayed silent after a tick.
    await Promise.resolve();
    expect(replies).toHaveLength(0);
  });

  test("ignores a request that did not come from the frame's own window", async () => {
    useConversationStore.setState({ activeConversationId: "conv-active" });
    mountProxy();

    requestContext("c1", { source: window });

    await Promise.resolve();
    expect(replies).toHaveLength(0);
  });

  test("refuses to answer when the bridge is disabled", async () => {
    useConversationStore.setState({ activeConversationId: "conv-active" });
    mountProxy({ enabled: false });

    requestContext("c1");

    await waitFor(() => expect(replies).toHaveLength(1));
    expect(replies[0]).toEqual({
      type: "vellum_context_response",
      callId: "c1",
      error: "Context bridge disabled",
    });
    expect(replies[0]).not.toHaveProperty("activeConversationId");
  });
});
