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
 * Exit is the load-bearing behavior: the ✕ control and the global Escape key
 * both end the session, the control renders even with no assistant resolved,
 * and the key listeners are removed on unmount (no leaks).
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";

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

describe("VoiceRoom — exit", () => {
  test("✕ click ends the session via controls.stop", () => {
    startOwnedSession("listening");
    render(<VoiceRoom />);
    fireEvent.click(exitButton()!);
    expect(controls.stop).toHaveBeenCalledTimes(1);
  });

  test("Escape ends the session via controls.stop", () => {
    startOwnedSession("listening");
    render(<VoiceRoom />);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(controls.stop).toHaveBeenCalledTimes(1);
  });

  test("Escape ends the session even when an editable element holds focus (global exit)", () => {
    startOwnedSession("listening");
    render(<VoiceRoom />);
    // The room can open while the composer textarea still owns focus; Escape is
    // a global exit and must fire regardless of the editable target guard.
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    expect(controls.stop).toHaveBeenCalledTimes(1);
    input.remove();
  });

  test("the exit control renders even with no assistant resolved", () => {
    startOwnedSession("listening");
    useLiveVoiceStore.setState({ assistantId: null });
    render(<VoiceRoom />);
    expect(exitButton()).not.toBeNull();
    expect(screen.getByTestId("voice-avatar").textContent).toBe("no-assistant");
  });

  test("key listeners are removed on unmount — no stray Escape teardown", () => {
    startOwnedSession("listening");
    const { unmount } = render(<VoiceRoom />);
    unmount();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(controls.stop).not.toHaveBeenCalled();
  });
});

describe("VoiceRoom — push-to-talk fallback", () => {
  test("Space releases the current turn while listening", () => {
    startOwnedSession("listening");
    render(<VoiceRoom />);
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: " ", code: "Space" }),
    );
    expect(controls.release).toHaveBeenCalledTimes(1);
  });

  test("Space on the focused exit control is left for the button to activate (not swallowed)", () => {
    startOwnedSession("listening");
    render(<VoiceRoom />);
    const event = new KeyboardEvent("keydown", {
      key: " ",
      code: "Space",
      bubbles: true,
      cancelable: true,
    });
    exitButton()!.dispatchEvent(event);
    // The global shortcut steps aside: no push-to-talk release, and Space's
    // default (native button activation) is left intact.
    expect(controls.release).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  test("Space in a text field is left for the field (not swallowed as push-to-talk)", () => {
    startOwnedSession("listening");
    render(<VoiceRoom />);
    const input = document.createElement("input");
    document.body.appendChild(input);
    const event = new KeyboardEvent("keydown", {
      key: " ",
      code: "Space",
      bubbles: true,
      cancelable: true,
    });
    input.dispatchEvent(event);
    // The editable guard applies to Space: no release, and the field's own
    // space-to-type default is left intact.
    expect(controls.release).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
    input.remove();
  });

  test("Space is inert while the assistant is speaking", () => {
    startOwnedSession("speaking");
    render(<VoiceRoom />);
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: " ", code: "Space" }),
    );
    expect(controls.release).not.toHaveBeenCalled();
  });

  test("tapping the orb releases the current turn while listening", () => {
    startOwnedSession("listening");
    render(<VoiceRoom />);
    fireEvent.click(screen.getByRole("button", { name: "Speak" }));
    expect(controls.release).toHaveBeenCalledTimes(1);
  });
});
