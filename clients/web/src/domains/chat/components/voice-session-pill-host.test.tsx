/**
 * Tests for `VoiceSessionPillHost`.
 *
 * The host wires real Zustand stores (live-voice, conversation) to the
 * presentational `VoiceSessionPill`, so tests drive those stores directly and
 * mock only the modules with heavy dependency graphs: router hooks (mutable
 * pathname + navigate spy), `useActiveConversation` (TanStack Query), the
 * viewer store (generated SDK imports), and the imperative
 * `navigateToConversation` util (haptics/sounds).
 *
 * The embedded `VoiceTimelineWaveform` renders a real canvas — happy-dom's
 * `getContext("2d")` returns `null`, which that component treats as "don't
 * start the draw loop", so no canvas harness is needed.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import type { MainView } from "@/stores/viewer-store";
import type { Conversation } from "@/types/conversation-types";
import { routes } from "@/utils/routes";

import {
  useLiveVoiceStore,
  type LiveVoiceSessionState,
} from "@/domains/chat/voice/live-voice/live-voice-store";
import { useConversationStore } from "@/stores/conversation-store";

const OWNING_CONVERSATION_ID = "conv-owning";
const OTHER_CONVERSATION_ID = "conv-other";
const ASSISTANT_ID = "assistant-1";

let mockPathname = routes.conversation(OTHER_CONVERSATION_ID);
const navigateFn = mock(() => {});
mock.module("react-router", () => ({
  useLocation: () => ({ pathname: mockPathname }),
  useNavigate: () => navigateFn,
}));

let mockOwningConversation: Conversation | undefined;
const useActiveConversationSpy = mock(
  (_assistantId: string | null, _conversationId: string | null | undefined, _enabled: boolean) =>
    mockOwningConversation,
);
mock.module("@/domains/chat/hooks/use-active-conversation", () => ({
  useActiveConversation: useActiveConversationSpy,
}));

let mockMainView: MainView = "chat";
mock.module("@/stores/viewer-store", () => ({
  useViewerStore: {
    use: {
      mainView: () => mockMainView,
    },
  },
}));

const navigateToConversationSpy = mock(
  (_navigate: unknown, _conversationId: string) => {},
);
mock.module("@/utils/conversation-navigation", () => ({
  navigateToConversation: navigateToConversationSpy,
}));

// Imported after the mocks so the host picks up the mocked modules.
const { VoiceSessionPillHost } = await import(
  "@/domains/chat/components/voice-session-pill-host"
);

const controls = {
  stop: mock(() => {}),
  release: mock(() => {}),
  interrupt: mock(() => {}),
};

/** Put the live-voice store into an active session owned by `conversationId`. */
function startSession(
  state: LiveVoiceSessionState = "listening",
  conversationId: string | null = OWNING_CONVERSATION_ID,
) {
  const store = useLiveVoiceStore.getState();
  store.setSessionContext(ASSISTANT_ID, conversationId);
  store.setControls(controls);
  store.setState(state);
}

beforeEach(() => {
  mockPathname = routes.conversation(OTHER_CONVERSATION_ID);
  mockMainView = "chat";
  mockOwningConversation = {
    conversationId: OWNING_CONVERSATION_ID,
    title: "Owning thread",
  };
  navigateFn.mockClear();
  navigateToConversationSpy.mockClear();
  useActiveConversationSpy.mockClear();
  controls.stop.mockClear();
  controls.release.mockClear();
  controls.interrupt.mockClear();
  useLiveVoiceStore.getState().reset();
  useConversationStore
    .getState()
    .setActiveConversationId(OTHER_CONVERSATION_ID);
});

afterEach(() => {
  cleanup();
  useLiveVoiceStore.getState().reset();
  useConversationStore.getState().reset();
});

const pill = () => screen.queryByRole("group", { name: "Voice session" });

describe("VoiceSessionPillHost — visibility", () => {
  test("renders nothing when no session is active", () => {
    const { container } = render(<VoiceSessionPillHost />);
    expect(container.firstChild).toBeNull();
  });

  test("renders the pill while viewing a different conversation", () => {
    startSession("listening");
    render(<VoiceSessionPillHost />);
    expect(pill()).not.toBeNull();
    expect(screen.getByText("Listening…")).toBeTruthy();
    expect(screen.getByText("Owning thread")).toBeTruthy();
  });

  test("hides the pill while viewing the owning conversation's composer", () => {
    startSession("listening");
    useConversationStore
      .getState()
      .setActiveConversationId(OWNING_CONVERSATION_ID);
    mockPathname = routes.conversation(OWNING_CONVERSATION_ID);
    const { container } = render(<VoiceSessionPillHost />);
    expect(container.firstChild).toBeNull();
  });

  test("shows the pill over the fullscreen app viewer even in the owning conversation", () => {
    startSession("listening");
    useConversationStore
      .getState()
      .setActiveConversationId(OWNING_CONVERSATION_ID);
    mockPathname = routes.conversation(OWNING_CONVERSATION_ID);
    mockMainView = "app";
    render(<VoiceSessionPillHost />);
    expect(pill()).not.toBeNull();
  });

  test("shows the pill on a non-conversation route even when the owning id is still active", () => {
    // `activeConversationId` deliberately persists across route changes, so
    // the id comparison alone can't detect that the composer left the screen.
    startSession("listening");
    useConversationStore
      .getState()
      .setActiveConversationId(OWNING_CONVERSATION_ID);
    mockPathname = routes.home;
    render(<VoiceSessionPillHost />);
    expect(pill()).not.toBeNull();
  });

  test("hides the pill for a session with no owning conversation", () => {
    startSession("listening", null);
    const { container } = render(<VoiceSessionPillHost />);
    expect(container.firstChild).toBeNull();
  });

  test("renders nothing after the session fails", () => {
    startSession("listening");
    useLiveVoiceStore.getState().fail("boom");
    const { container } = render(<VoiceSessionPillHost />);
    expect(container.firstChild).toBeNull();
  });
});

describe("VoiceSessionPillHost — labels", () => {
  test("omits the thread name while the owning row is still loading", () => {
    mockOwningConversation = undefined;
    startSession("thinking");
    render(<VoiceSessionPillHost />);
    expect(screen.getByText("Thinking…")).toBeTruthy();
    expect(screen.queryByText("Owning thread")).toBeNull();
  });

  test("falls back to Untitled for an owning row without a title", () => {
    mockOwningConversation = { conversationId: OWNING_CONVERSATION_ID };
    startSession("listening");
    render(<VoiceSessionPillHost />);
    expect(screen.getByText("Untitled")).toBeTruthy();
  });

  test("resolves the owning row only while visible", () => {
    startSession("listening");
    render(<VoiceSessionPillHost />);
    expect(useActiveConversationSpy).toHaveBeenCalledWith(
      ASSISTANT_ID,
      OWNING_CONVERSATION_ID,
      true,
    );
  });
});

describe("VoiceSessionPillHost — controls", () => {
  test("✕ ends the session via controls.stop", () => {
    startSession("listening");
    render(<VoiceSessionPillHost />);
    fireEvent.click(screen.getByRole("button", { name: "End voice session" }));
    expect(controls.stop).toHaveBeenCalledTimes(1);
    expect(controls.release).not.toHaveBeenCalled();
    expect(controls.interrupt).not.toHaveBeenCalled();
  });

  test("↑ releases the current turn via controls.release", () => {
    startSession("listening");
    render(<VoiceSessionPillHost />);
    fireEvent.click(screen.getByRole("button", { name: "Send now" }));
    expect(controls.release).toHaveBeenCalledTimes(1);
    expect(controls.stop).not.toHaveBeenCalled();
  });

  test("■ interrupts the assistant via controls.interrupt while speaking", () => {
    startSession("speaking");
    render(<VoiceSessionPillHost />);
    fireEvent.click(
      screen.getByRole("button", { name: "Stop assistant response" }),
    );
    expect(controls.interrupt).toHaveBeenCalledTimes(1);
    expect(controls.stop).not.toHaveBeenCalled();
  });

  test("controls are no-ops when none are registered", () => {
    startSession("listening");
    useLiveVoiceStore.getState().setControls(null);
    render(<VoiceSessionPillHost />);
    expect(() => {
      fireEvent.click(
        screen.getByRole("button", { name: "End voice session" }),
      );
    }).not.toThrow();
  });
});

describe("VoiceSessionPillHost — navigation", () => {
  test("clicking the label navigates to the owning conversation", () => {
    startSession("listening");
    render(<VoiceSessionPillHost />);
    fireEvent.click(
      screen.getByRole("button", { name: "Go to voice session thread" }),
    );
    expect(navigateToConversationSpy).toHaveBeenCalledTimes(1);
    expect(navigateToConversationSpy).toHaveBeenCalledWith(
      navigateFn,
      OWNING_CONVERSATION_ID,
    );
  });
});
