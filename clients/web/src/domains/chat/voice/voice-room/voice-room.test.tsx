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
 * Exit is the load-bearing behavior: the room is a full-app takeover with no
 * minimize — the ✕ control (which ends the session) is the only way out, it
 * renders even with no assistant resolved, and Escape deliberately does
 * nothing (an accidental keypress must not end a live call).
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

// The room resolves its look (color-with-eyes vs the ambient void) and the
// wave accent from the session avatar; stub the hook — with mutable data so
// look tests can exercise both — to avoid the assistant-avatar React Query
// graph.
let mockAvatarData: {
  components: unknown;
  traits: unknown;
  customImageUrl: string | null;
} = { components: null, traits: null, customImageUrl: null };
mock.module("@/hooks/use-assistant-avatar", () => ({
  useAssistantAvatar: () => ({ ...mockAvatarData }),
  avatarQueryKey: (id: string) => ["assistantAvatar", id],
}));

/** Minimal character components: one body/eye/color of each. */
const CHARACTER_COMPONENTS = {
  bodyShapes: [{ id: "sprout", svgPath: "M0 0 L10 0 L10 10 Z" }],
  eyeStyles: [
    {
      id: "curious",
      paths: [{ svgPath: "M0 0 L10 0 L10 10 Z", color: "#FFFFFF" }],
    },
  ],
  colors: [{ id: "green", hex: "#4C9B50" }],
};

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
  mockAvatarData = { components: null, traits: null, customImageUrl: null };
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

});

describe("VoiceRoom — no way out but ending the session", () => {
  test("no minimize control renders", () => {
    startOwnedSession("listening");
    render(<VoiceRoom />);
    expect(
      screen.queryByRole("button", { name: "Minimize voice room" }),
    ).toBeNull();
  });

  test("Escape neither dismisses the room nor ends the session", () => {
    startOwnedSession("listening");
    render(<VoiceRoom />);
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(roomDialog()).not.toBeNull();
    expect(controls.stop).not.toHaveBeenCalled();
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

describe("VoiceRoom — mute toggle", () => {
  test("mute drives the registered setMuted control", () => {
    startOwnedSession("listening");
    render(<VoiceRoom />);
    fireEvent.click(screen.getByRole("button", { name: "Mute microphone" }));
    expect(controls.setMuted).toHaveBeenCalledWith(true);
  });

  test("muted: offers unmute", () => {
    startOwnedSession("listening");
    useLiveVoiceStore.setState({ muted: true });
    render(<VoiceRoom />);
    const toggle = screen.getByRole("button", { name: "Unmute microphone" });
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(toggle);
    expect(controls.setMuted).toHaveBeenCalledWith(false);
  });
});

describe("VoiceRoom — stop response", () => {
  const stopButton = () =>
    screen.queryByRole("button", { name: "Stop assistant response" });

  test("■ renders while speaking hands-free and drives the interrupt control", () => {
    startOwnedSession("speaking");
    useLiveVoiceStore.setState({ handsFree: true });
    render(<VoiceRoom />);
    fireEvent.click(stopButton()!);
    expect(controls.interrupt).toHaveBeenCalledTimes(1);
    expect(controls.stop).not.toHaveBeenCalled();
  });

  test("no ■ outside speaking, or for a manual (fallback) session", () => {
    startOwnedSession("listening");
    useLiveVoiceStore.setState({ handsFree: true });
    const { unmount } = render(<VoiceRoom />);
    expect(stopButton()).toBeNull();
    unmount();

    // Manual session (version-skew fallback): interrupt would end the whole
    // session, so the room must not offer the turn-scoped control.
    startOwnedSession("speaking");
    useLiveVoiceStore.setState({ handsFree: false });
    render(<VoiceRoom />);
    expect(stopButton()).toBeNull();
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

describe("VoiceRoom — full-app takeover", () => {
  test("the room is a modal full-viewport overlay", () => {
    startOwnedSession("listening");
    render(<VoiceRoom />);
    const dialog = roomDialog()!;
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.className).toContain("fixed inset-0");
  });
});

describe("VoiceRoom — looks (color-with-eyes vs ambient void)", () => {
  const eyes = () => screen.queryByTestId("voice-room-eyes");

  test("a character avatar gets the color-with-eyes look", () => {
    mockAvatarData = {
      components: CHARACTER_COMPONENTS,
      traits: { bodyShape: "sprout", eyeStyle: "curious", color: "green" },
      customImageUrl: null,
    };
    startOwnedSession("listening");
    render(<VoiceRoom />);
    expect(eyes()).not.toBeNull();
    // The eyes replace the void look's cast: no centered avatar, no waves.
    expect(screen.queryByTestId("voice-avatar")).toBeNull();
    expect(screen.queryByTestId("listening-waves")).toBeNull();
    // The exit control stays available regardless of look.
    expect(exitButton()).not.toBeNull();
  });

  test("a default character (no traits) gets first-component eyes", () => {
    mockAvatarData = {
      components: CHARACTER_COMPONENTS,
      traits: null,
      customImageUrl: null,
    };
    startOwnedSession("listening");
    render(<VoiceRoom />);
    expect(eyes()).not.toBeNull();
  });

  test("a custom-image avatar keeps the ambient-void look", () => {
    mockAvatarData = {
      components: CHARACTER_COMPONENTS,
      traits: null,
      customImageUrl: "blob:custom-avatar",
    };
    startOwnedSession("listening");
    render(<VoiceRoom />);
    expect(eyes()).toBeNull();
    expect(screen.getByTestId("voice-avatar")).toBeTruthy();
    expect(screen.getByTestId("listening-waves")).toBeTruthy();
  });

  test("an unresolved avatar (still loading) keeps the ambient-void look", () => {
    startOwnedSession("listening");
    render(<VoiceRoom />);
    expect(eyes()).toBeNull();
    expect(screen.getByTestId("voice-avatar")).toBeTruthy();
  });
});

describe("VoiceRoom — no push-to-talk / manual-release affordance (hands-free)", () => {
  // Sessions are hands-free (server-VAD): the user just speaks, so the room
  // offers no push-to-talk control and no manual "send now" — the controller's
  // `release` seam is a no-op for hands-free sessions, so such a control would
  // be dead (PR #37913 review). Space and Enter are not intercepted; a focused
  // room control keeps its native Enter activation.
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

  test("Enter is not intercepted while listening — no dead send-now shortcut", () => {
    startOwnedSession("listening");
    render(<VoiceRoom />);
    const event = new KeyboardEvent("keydown", {
      key: "Enter",
      cancelable: true,
    });
    window.dispatchEvent(event);
    expect(controls.release).not.toHaveBeenCalled();
    // No preventDefault: a focused room control keeps native Enter activation.
    expect(event.defaultPrevented).toBe(false);
  });

  test("there is no tappable Speak orb and no Send now control", () => {
    startOwnedSession("listening");
    render(<VoiceRoom />);
    expect(screen.queryByRole("button", { name: "Speak" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Send now/ })).toBeNull();
  });
});
