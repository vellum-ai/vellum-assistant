/**
 * What a draft's first POST settles: the mint gate, and the URL the resolved
 * conversation lands on.
 *
 * The draft-mint gate blocks a second send while that POST is in flight, and
 * is released however it settles. A gate still held after the POST rejects
 * refuses every later send for that draft with "Setting up your conversation.
 * Please try again in a moment." for the rest of the session, so the rejection
 * path is the one worth pinning.
 *
 * The success path swaps the draft key for the server's id and replaces the
 * URL with it. The app the URL already names is carried across, so the id
 * swap closes neither an app on screen nor one an overlay is covering, and the
 * return path the entry records rides along re-keyed, so the close still pops.
 *
 * Driven end-to-end against a spied daemon client, mirroring the sibling
 * plugins test so the module registry stays clean.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { type ReactNode } from "react";

import { client as daemonClient } from "@/generated/daemon/client.gen";
import { useSendMessage } from "@/domains/chat/hooks/use-send-message";
import { useComposerStore } from "@/domains/chat/composer-store";
import { useConversationStore } from "@/stores/conversation-store";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { useChatSessionStore } from "@/domains/chat/chat-session-store";
import { useTurnStore, INITIAL_TURN_STATE } from "@/domains/chat/turn-store";
import { useViewerStore } from "@/stores/viewer-store";
import {
  appEntryStateFor,
  SAMPLE_APP,
  showOpenAppRoute,
  showPath,
} from "@/stores/open-app.test-helper";
import {
  currentLocation,
  LocationProbe,
} from "@/hooks/router-probe.test-helper";
import { routes } from "@/utils/routes";

const DRAFT_ID = "draft-1";
/** The id the daemon mints for the draft's first message. */
const SERVER_ID = "conv-server-1";

let postCalls = 0;
const originalPost = daemonClient.post;

const queryClient = new QueryClient();

function Wrapper({ children }: { children: ReactNode }) {
  return (
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        {children}
        <LocationProbe />
      </QueryClientProvider>
    </MemoryRouter>
  );
}

function baseProps() {
  return {
    assistantId: "assistant-1",
    activeConversationId: DRAFT_ID,
    diskPressureChatBlockReason: null,
    uiContextRef: { current: null },
    pendingOnboardingContextRef: { current: null },
    onboardingDraftConversationIdRef: { current: null },
    startReconciliationLoop: () => {},
    cancelReconciliation: () => {},
    refreshConversations: async () => {},
  };
}

beforeEach(() => {
  postCalls = 0;
  queryClient.clear();
  useConversationStore.getState().reset();
  useTurnStore.setState(INITIAL_TURN_STATE);
  useChatSessionStore.getState().setOptimisticSends([]);
  useChatSessionStore.getState().setError(null);
  useComposerStore.getState().setInput("");
  useResolvedAssistantsStore.getState().setActiveAssistantId(null);
  useViewerStore.getState().reset();

  daemonClient.post = mock(async () => {
    postCalls += 1;
    throw new Error("Load failed");
  }) as typeof daemonClient.post;
});

afterEach(() => {
  daemonClient.post = originalPost;
  useViewerStore.getState().reset();
  showPath(routes.assistant);
  cleanup();
});

/** A daemon that accepts the message and answers with an id of its own. */
function acceptWithServerId(): void {
  daemonClient.post = mock(async () => ({
    data: { accepted: true, conversationId: SERVER_ID, messageId: "m1" },
    error: null,
    response: new Response(null, { status: 200 }),
  })) as typeof daemonClient.post;
}

describe("useSendMessage: draft-mint gate", () => {
  test("releases the gate when the POST throws, so a later send is accepted", async () => {
    useAssistantIdentityStore.getState().setIdentity("Assistant", "0.10.12");
    const { result } = renderHook(() => useSendMessage(baseProps()), {
      wrapper: Wrapper,
    });

    await act(async () => {
      await result.current.sendMessage("first attempt");
    });
    await act(async () => {
      await result.current.sendMessage("second attempt");
    });

    // A held gate short-circuits before the request, so the second attempt
    // reaching the client is what proves it was released.
    expect(postCalls).toBe(2);
  });
});

describe("useSendMessage: a draft resolving to its server id", () => {
  /** The path the draft's first send left the router on. */
  async function sendFirstMessage(): Promise<string> {
    useAssistantIdentityStore.getState().setIdentity("Assistant", "0.10.12");
    useConversationStore.getState().setActiveConversationId(DRAFT_ID);
    acceptWithServerId();
    const { result } = renderHook(() => useSendMessage(baseProps()), {
      wrapper: Wrapper,
    });

    await act(async () => {
      await result.current.sendMessage("first message");
    });

    return currentLocation().pathname;
  }

  test("names the app held beside the draft, so the id swap does not close it", async () => {
    showOpenAppRoute({ conversationId: DRAFT_ID });

    expect(await sendFirstMessage()).toBe(
      routes.conversation(SERVER_ID, SAMPLE_APP.appId),
    );
  });

  test("keeps the app an overlay covers, which the URL still names", async () => {
    // `keptAppId()` reads the app on screen and an overlay leaves none, so
    // the rewrite reads the URL instead of releasing an app the user has.
    showOpenAppRoute({ conversationId: DRAFT_ID });
    useViewerStore.setState({ mainView: "document" });

    expect(await sendFirstMessage()).toBe(
      routes.conversation(SERVER_ID, SAMPLE_APP.appId),
    );
  });

  test("names no app when the viewer is on the chat", async () => {
    expect(await sendFirstMessage()).toBe(routes.conversation(SERVER_ID));
  });

  test("re-keys the return path the entry records, so the close still pops", async () => {
    showOpenAppRoute({
      conversationId: DRAFT_ID,
      entryState: appEntryStateFor(DRAFT_ID),
    });

    await sendFirstMessage();

    expect(currentLocation().state).toEqual(appEntryStateFor(SERVER_ID));
  });

  test("records the replacement, so an entry naming the draft finds the row", async () => {
    await sendFirstMessage();

    expect(
      useConversationStore.getState().draftReplacements.get(DRAFT_ID),
    ).toBe(SERVER_ID);
  });

  test("records nothing when the entry the app sits on records nothing", async () => {
    showOpenAppRoute({ conversationId: DRAFT_ID });

    await sendFirstMessage();

    expect(currentLocation().state).toBeNull();
  });
});
