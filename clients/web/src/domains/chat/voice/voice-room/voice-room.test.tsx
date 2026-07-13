/**
 * Tests for `VoiceRoom`.
 *
 * The room is a pure function of {@link useIsVoiceRoomVisible} (session active
 * AND the on-screen composer owns it), so tests drive the real live-voice and
 * conversation stores and mock only the modules with heavy dependency graphs:
 * router hooks (mutable pathname), the viewer store (generated SDK imports),
 * the `useIsMobile` media-query hook, and `VoiceAvatar` (which pulls in the
 * assistant-avatar React Query graph — irrelevant to room chrome, and stubbed
 * so the exit control's independence from avatar readiness is testable).
 *
 * Exit and minimize are the load-bearing behaviors: the ✕ control ends the
 * session, Escape / the minimize control collapse the room WITHOUT ending the
 * session (the composer's voice bar takes over), the ✕ renders even with no
 * assistant resolved, and the key listeners are removed on unmount (no leaks).
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

import type { MainView } from "@/stores/viewer-store";
import { routes } from "@/utils/routes";

import {
  makeControlsSpies,
  seedLiveVoiceSession,
} from "@/domains/chat/voice/live-voice/live-voice-fakes.test-helper";
import {
  useLiveVoiceStore,
  type LiveVoiceSessionState,
} from "@/domains/chat/voice/live-voice/live-voice-store";
import { useConversationStore } from "@/stores/conversation-store";
import { useVoicePrefsStore } from "@/stores/voice-prefs-store";

const OWNING_CONVERSATION_ID = "conv-owning";
const OTHER_CONVERSATION_ID = "conv-other";
const ASSISTANT_ID = "assistant-1";

let mockPathname = routes.conversation(OWNING_CONVERSATION_ID);
// `search` feeds the room's pop-out gate (`isPopoutWindow`): "" is the main
// window, "?popout=1" is an Electron pop-out thread window.
let mockSearch = "";
mock.module("react-router", () => ({
  useLocation: () => ({ pathname: mockPathname, search: mockSearch }),
}));

let mockMainView: MainView = "chat";
mock.module("@/stores/viewer-store", () => ({
  useViewerStore: {
    use: {
      mainView: () => mockMainView,
    },
  },
}));

let mockIsMobile = false;
mock.module("@/hooks/use-is-mobile", () => ({
  useIsMobile: () => mockIsMobile,
  MOBILE_MEDIA_QUERY: "(max-width: 767px)",
}));

// Stub the avatar so the room's own chrome (exit control, key handlers) is
// tested without the assistant-avatar query graph, and so "renders even with
// null avatar data" is expressible.
mock.module("@/domains/chat/voice/voice-room/voice-avatar", () => ({
  VoiceAvatar: ({ assistantId }: { assistantId: string | null }) => (
    <div data-testid="voice-avatar">{assistantId ?? "no-assistant"}</div>
  ),
}));

// Stub the listening waves (rAF loop + SVG geometry) so the room-chrome tests
// stay focused on wiring: we only assert the room mounts them in the right
// phase, not how they animate.
mock.module("@/domains/chat/voice/voice-room/voice-listening-waves", () => ({
  VoiceListeningWaves: () => <div data-testid="listening-waves" />,
}));

// The room reads the session avatar to tint the waves to the assistant color;
// stub the hook so these tests don't need the assistant-avatar React Query
// graph (the room-chrome behavior is independent of avatar data).
mock.module("@/hooks/use-assistant-avatar", () => ({
  useAssistantAvatar: () => ({
    components: null,
    traits: null,
    customImageUrl: null,
  }),
  avatarQueryKey: (id: string) => ["assistantAvatar", id],
}));

// Imported after the mocks so the room picks up the mocked modules.
const { VoiceRoom } = await import("@/domains/chat/voice/voice-room/voice-room");

const controls = makeControlsSpies();

/** Seed an active session owned by the on-screen composer's conversation. */
function startOwnedSession(state: LiveVoiceSessionState = "listening") {
  seedLiveVoiceSession(state, {
    assistantId: ASSISTANT_ID,
    conversationId: OWNING_CONVERSATION_ID,
    controls,
  });
}

beforeEach(() => {
  mockPathname = routes.conversation(OWNING_CONVERSATION_ID);
  mockSearch = "";
  mockMainView = "chat";
  mockIsMobile = false;
  controls.stop.mockClear();
  controls.release.mockClear();
  controls.interrupt.mockClear();
  useLiveVoiceStore.getState().reset();
  useConversationStore
    .getState()
    .setActiveConversationId(OWNING_CONVERSATION_ID);
  // Captions default off; individual tests flip them through the room control.
  useVoicePrefsStore.setState({
    showUserTranscript: false,
    showAssistantTranscript: false,
  });
});

afterEach(() => {
  cleanup();
  useLiveVoiceStore.getState().reset();
  useConversationStore.getState().reset();
});

const roomDialog = () =>
  screen.queryByRole("dialog", { name: "Voice session" });
const exitButton = () =>
  screen.queryByRole("button", { name: "Exit voice session" });

describe("VoiceRoom — visibility", () => {
  test("renders nothing when no session is active", () => {
    render(<VoiceRoom />);
    expect(roomDialog()).toBeNull();
  });

  test("renders the room when the on-screen composer owns an active session", () => {
    startOwnedSession("listening");
    render(<VoiceRoom />);
    expect(roomDialog()).not.toBeNull();
    expect(exitButton()).not.toBeNull();
    expect(screen.getByTestId("voice-avatar").textContent).toBe(ASSISTANT_ID);
  });

  test("renders nothing once navigated to another conversation (composer no longer owns)", () => {
    startOwnedSession("listening");
    useConversationStore
      .getState()
      .setActiveConversationId(OTHER_CONVERSATION_ID);
    mockPathname = routes.conversation(OTHER_CONVERSATION_ID);
    render(<VoiceRoom />);
    expect(roomDialog()).toBeNull();
  });

  test("renders nothing over the desktop fullscreen app viewer (composer replaced)", () => {
    startOwnedSession("listening");
    mockMainView = "app";
    render(<VoiceRoom />);
    expect(roomDialog()).toBeNull();
  });

  test("renders nothing in an Electron pop-out even when the composer owns the session", () => {
    // The `fixed inset-0` room would cover the pop-out's standalone pill, so
    // pop-outs never show it — the standalone pill is their only session
    // surface. The owning composer's voice bar still renders underneath.
    startOwnedSession("listening");
    mockSearch = "?popout=1";
    render(<VoiceRoom />);
    expect(roomDialog()).toBeNull();
  });
});

describe("VoiceRoom — listening waves", () => {
  const waves = () => screen.queryByTestId("listening-waves");

  test("mounts the bottom waves while listening (energy coming in)", () => {
    startOwnedSession("listening");
    render(<VoiceRoom />);
    expect(roomDialog()).not.toBeNull();
    expect(waves()).not.toBeNull();
  });

  test("hides the waves while responding — the avatar emanates instead", () => {
    startOwnedSession("speaking");
    render(<VoiceRoom />);
    // Room is still open (an active phase), but there are no incoming waves.
    expect(roomDialog()).not.toBeNull();
    expect(waves()).toBeNull();
  });

  test("hides the waves while thinking", () => {
    startOwnedSession("thinking");
    render(<VoiceRoom />);
    expect(waves()).toBeNull();
  });
});

describe("VoiceRoom — exit", () => {
  test("✕ click ends the session via controls.stop", () => {
    startOwnedSession("listening");
    render(<VoiceRoom />);
    fireEvent.click(exitButton()!);
    expect(controls.stop).toHaveBeenCalledTimes(1);
  });

  test("the exit control renders even with no assistant resolved", () => {
    startOwnedSession("listening");
    useLiveVoiceStore.setState({ assistantId: null });
    render(<VoiceRoom />);
    expect(exitButton()).not.toBeNull();
    expect(screen.getByTestId("voice-avatar").textContent).toBe("no-assistant");
  });

  test("key listeners are removed on unmount — no stray Escape handling", () => {
    startOwnedSession("listening");
    const { unmount } = render(<VoiceRoom />);
    unmount();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(useLiveVoiceStore.getState().roomMinimized).toBe(false);
    expect(controls.stop).not.toHaveBeenCalled();
  });
});

describe("VoiceRoom — minimize (session keeps running)", () => {
  test("Escape minimizes the room without ending the session", () => {
    startOwnedSession("listening");
    render(<VoiceRoom />);
    // act: minimizing flips the store flag, which re-renders (unmounts) the room.
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(useLiveVoiceStore.getState().roomMinimized).toBe(true);
    expect(controls.stop).not.toHaveBeenCalled();
  });

  test("Escape minimizes even when an editable element holds focus (global key)", () => {
    startOwnedSession("listening");
    render(<VoiceRoom />);
    // The room can open while the composer textarea still owns focus; the key
    // is global and must fire regardless of the editable target guard.
    const input = document.createElement("input");
    document.body.appendChild(input);
    act(() => {
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    expect(useLiveVoiceStore.getState().roomMinimized).toBe(true);
    expect(controls.stop).not.toHaveBeenCalled();
    input.remove();
  });

  test("the minimize control minimizes without ending the session", () => {
    startOwnedSession("listening");
    render(<VoiceRoom />);
    fireEvent.click(
      screen.getByRole("button", { name: "Minimize voice room" }),
    );
    expect(useLiveVoiceStore.getState().roomMinimized).toBe(true);
    expect(controls.stop).not.toHaveBeenCalled();
  });

  test("a minimized room does not render for an owned active session", () => {
    startOwnedSession("listening");
    useLiveVoiceStore.getState().setRoomMinimized(true);
    render(<VoiceRoom />);
    expect(roomDialog()).toBeNull();
  });
});

describe("VoiceRoom — send now (manual turn release)", () => {
  const sendNowButton = () => screen.queryByRole("button", { name: /Send now/ });

  test("the Send now control releases the turn while listening", () => {
    startOwnedSession("listening");
    render(<VoiceRoom />);
    fireEvent.click(sendNowButton()!);
    expect(controls.release).toHaveBeenCalledTimes(1);
  });

  test("no Send now control outside listening", () => {
    startOwnedSession("speaking");
    render(<VoiceRoom />);
    expect(sendNowButton()).toBeNull();
  });

  test("Enter releases the turn while listening", () => {
    startOwnedSession("listening");
    render(<VoiceRoom />);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(controls.release).toHaveBeenCalledTimes(1);
  });

  test("Enter is inert outside listening", () => {
    startOwnedSession("speaking");
    render(<VoiceRoom />);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(controls.release).not.toHaveBeenCalled();
  });
});

describe("VoiceRoom — captions toggle", () => {
  test("toggling captions on flips both persisted transcript prefs", () => {
    startOwnedSession("listening");
    render(<VoiceRoom />);
    fireEvent.click(screen.getByRole("button", { name: "Show captions" }));
    const prefs = useVoicePrefsStore.getState();
    expect(prefs.showUserTranscript).toBe(true);
    expect(prefs.showAssistantTranscript).toBe(true);
  });

  test("with any transcript pref on, the control offers to hide and clears both", () => {
    useVoicePrefsStore.setState({ showUserTranscript: true });
    startOwnedSession("listening");
    render(<VoiceRoom />);
    fireEvent.click(screen.getByRole("button", { name: "Hide captions" }));
    const prefs = useVoicePrefsStore.getState();
    expect(prefs.showUserTranscript).toBe(false);
    expect(prefs.showAssistantTranscript).toBe(false);
  });
});

describe("VoiceRoom — connect feedback", () => {
  test("shows the connecting label while the session connects", () => {
    startOwnedSession("connecting");
    render(<VoiceRoom />);
    expect(
      screen.getByTestId("voice-room-connect-label").textContent,
    ).toBe("Connecting…");
  });

  test("relabels to Reconnecting… while retrying a dropped connection", () => {
    startOwnedSession("connecting");
    useLiveVoiceStore.getState().setReconnecting(true);
    render(<VoiceRoom />);
    expect(
      screen.getByTestId("voice-room-connect-label").textContent,
    ).toBe("Reconnecting…");
  });

  test("no connect label once listening", () => {
    startOwnedSession("listening");
    render(<VoiceRoom />);
    expect(screen.queryByTestId("voice-room-connect-label")).toBeNull();
  });
});

describe("VoiceRoom — placement variants", () => {
  test("the fullscreen (mobile) variant is modal", () => {
    startOwnedSession("listening");
    render(<VoiceRoom variant="fullscreen" />);
    expect(roomDialog()!.getAttribute("aria-modal")).toBe("true");
  });

  test("the content (desktop) variant is not modal — surrounding chrome stays usable", () => {
    startOwnedSession("listening");
    render(<VoiceRoom variant="content" />);
    expect(roomDialog()!.getAttribute("aria-modal")).toBeNull();
  });
});

describe("VoiceRoom — no push-to-talk affordance (hands-free)", () => {
  // Sessions are hands-free (server-VAD): the user just speaks, so the room
  // offers no push-to-talk control. Space is not intercepted and there is no
  // tappable "Speak" orb — the "Send now" control is a manual turn RELEASE
  // (like the composer bar's ↑), not a hold-to-talk affordance.
  test("Space does not release the current turn while listening", () => {
    startOwnedSession("listening");
    render(<VoiceRoom />);
    const event = new KeyboardEvent("keydown", {
      key: " ",
      code: "Space",
      cancelable: true,
    });
    window.dispatchEvent(event);
    expect(controls.release).not.toHaveBeenCalled();
    // The room leaves Space alone entirely — no preventDefault.
    expect(event.defaultPrevented).toBe(false);
  });

  test("there is no tappable Speak orb", () => {
    startOwnedSession("listening");
    render(<VoiceRoom />);
    expect(screen.queryByRole("button", { name: "Speak" })).toBeNull();
  });
});
