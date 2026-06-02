import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type { MutableRefObject } from "react";

import type { ReachabilityPhase } from "@/assistant/use-assistant-reachability";
import { useInitialMessageLaunch } from "@/domains/chat/hooks/use-initial-message-launch";
import { INITIAL_MESSAGE_SESSION_KEY } from "@/utils/initial-message-launch";

type PendingInitialMessage = {
  conversationId: string;
  content: string;
};

const PROMPT =
  "Please load the llm-cost-optimizer skill. Analyze my recent LLM usage.";

describe("useInitialMessageLaunch", () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  afterEach(() => {
    cleanup();
    sessionStorage.clear();
  });

  function renderLaunchHook({
    assistantId = "asst-1",
    activeConversationId = null,
    reachabilityPhase = "ready",
    pendingInitialMessageRef = {
      current: null,
    } as MutableRefObject<PendingInitialMessage | null>,
    startNewConversation = mock(() => {}),
    sendMessage = mock(async () => {}),
    probeReachability = mock(() => {}),
  }: {
    assistantId?: string | null;
    activeConversationId?: string | null;
    reachabilityPhase?: ReachabilityPhase;
    pendingInitialMessageRef?: MutableRefObject<PendingInitialMessage | null>;
    startNewConversation?: (opts?: {
      silent?: boolean;
      initialMessage?: string;
    }) => void;
    sendMessage?: (content: string) => Promise<void>;
    probeReachability?: () => void;
  } = {}) {
    return renderHook(
      (props: {
        assistantId: string | null;
        activeConversationId: string | null;
        reachabilityPhase: ReachabilityPhase;
      }) =>
        useInitialMessageLaunch({
          assistantId: props.assistantId,
          activeConversationId: props.activeConversationId,
          reachabilityPhase: props.reachabilityPhase,
          pendingInitialMessageRef,
          startNewConversation,
          sendMessage,
          probeReachability,
        }),
      {
        initialProps: {
          assistantId,
          activeConversationId,
          reachabilityPhase,
        },
      },
    );
  }

  test("consumes a stored prompt, starts a draft, and sends once when reachable", async () => {
    sessionStorage.setItem(INITIAL_MESSAGE_SESSION_KEY, PROMPT);
    const pendingInitialMessageRef: MutableRefObject<PendingInitialMessage | null> =
      { current: null };
    const startNewConversation = mock(
      (opts?: { silent?: boolean; initialMessage?: string }) => {
        pendingInitialMessageRef.current = {
          conversationId: "draft-1",
          content: opts?.initialMessage ?? "",
        };
      },
    );
    const sendMessage = mock(async () => {});

    const { rerender } = renderLaunchHook({
      activeConversationId: null,
      pendingInitialMessageRef,
      startNewConversation,
      sendMessage,
    });

    await waitFor(() =>
      expect(startNewConversation).toHaveBeenCalledWith({
        initialMessage: PROMPT,
      }),
    );
    expect(sessionStorage.getItem(INITIAL_MESSAGE_SESSION_KEY)).toBeNull();
    expect(sendMessage).not.toHaveBeenCalled();

    rerender({
      assistantId: "asst-1",
      activeConversationId: "draft-1",
      reachabilityPhase: "ready",
    });

    await waitFor(() => expect(sendMessage).toHaveBeenCalledWith(PROMPT));
    expect(pendingInitialMessageRef.current).toBeNull();

    rerender({
      assistantId: "asst-1",
      activeConversationId: "draft-1",
      reachabilityPhase: "ready",
    });
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  test("does not consume the stored prompt before an assistant is selected", async () => {
    sessionStorage.setItem(INITIAL_MESSAGE_SESSION_KEY, PROMPT);
    const startNewConversation = mock(() => {});

    const { rerender } = renderLaunchHook({
      assistantId: null,
      startNewConversation,
    });

    await Promise.resolve();
    expect(startNewConversation).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(INITIAL_MESSAGE_SESSION_KEY)).toBe(PROMPT);

    rerender({
      assistantId: "asst-1",
      activeConversationId: null,
      reachabilityPhase: "ready",
    });

    await waitFor(() => expect(startNewConversation).toHaveBeenCalled());
    expect(sessionStorage.getItem(INITIAL_MESSAGE_SESSION_KEY)).toBeNull();
  });

  test("waits for reachability before sending a staged initial message", async () => {
    const pendingInitialMessageRef: MutableRefObject<PendingInitialMessage | null> =
      {
        current: {
          conversationId: "draft-1",
          content: PROMPT,
        },
      };
    const sendMessage = mock(async () => {});

    const { rerender } = renderLaunchHook({
      activeConversationId: "draft-1",
      reachabilityPhase: "connecting",
      pendingInitialMessageRef,
      sendMessage,
    });

    await Promise.resolve();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(pendingInitialMessageRef.current?.content).toBe(PROMPT);

    rerender({
      assistantId: "asst-1",
      activeConversationId: "draft-1",
      reachabilityPhase: "ready",
    });

    await waitFor(() => expect(sendMessage).toHaveBeenCalledWith(PROMPT));
    expect(pendingInitialMessageRef.current).toBeNull();
  });

  test("probes reachability when a staged initial message is waiting from idle", async () => {
    const pendingInitialMessageRef: MutableRefObject<PendingInitialMessage | null> =
      {
        current: {
          conversationId: "draft-1",
          content: PROMPT,
        },
      };
    const probeReachability = mock(() => {});
    const sendMessage = mock(async () => {});

    renderLaunchHook({
      activeConversationId: "draft-1",
      reachabilityPhase: "idle",
      pendingInitialMessageRef,
      sendMessage,
      probeReachability,
    });

    await waitFor(() => expect(probeReachability).toHaveBeenCalledTimes(1));
    expect(sendMessage).not.toHaveBeenCalled();
    expect(pendingInitialMessageRef.current?.content).toBe(PROMPT);
  });

  test("carries a stored prompt across the index-to-conversation remount", async () => {
    sessionStorage.setItem(INITIAL_MESSAGE_SESSION_KEY, PROMPT);
    const firstMountPendingRef: MutableRefObject<PendingInitialMessage | null> =
      { current: null };
    const startNewConversation = mock(
      (opts?: { silent?: boolean; initialMessage?: string }) => {
        firstMountPendingRef.current = {
          conversationId: "draft-1",
          content: opts?.initialMessage ?? "",
        };
      },
    );

    const firstMount = renderLaunchHook({
      activeConversationId: null,
      pendingInitialMessageRef: firstMountPendingRef,
      startNewConversation,
    });

    await waitFor(() => expect(startNewConversation).toHaveBeenCalled());
    firstMount.unmount();

    const secondMountPendingRef: MutableRefObject<PendingInitialMessage | null> =
      { current: null };
    const probeReachability = mock(() => {});
    const sendMessage = mock(async () => {});

    const { rerender } = renderLaunchHook({
      activeConversationId: "draft-1",
      reachabilityPhase: "idle",
      pendingInitialMessageRef: secondMountPendingRef,
      probeReachability,
      sendMessage,
    });

    await waitFor(() => expect(probeReachability).toHaveBeenCalledTimes(1));
    expect(secondMountPendingRef.current?.content).toBe(PROMPT);

    rerender({
      assistantId: "asst-1",
      activeConversationId: "draft-1",
      reachabilityPhase: "ready",
    });

    await waitFor(() => expect(sendMessage).toHaveBeenCalledWith(PROMPT));
    expect(secondMountPendingRef.current).toBeNull();
  });
});
