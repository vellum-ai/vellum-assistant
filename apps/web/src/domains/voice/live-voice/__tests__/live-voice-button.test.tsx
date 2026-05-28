/**
 * Tests for `LiveVoiceButton`.
 *
 * Exercises the render gating (feature flag + assistant id) and the
 * state → method-call mapping. We inject a stub `managerFactory` so the
 * real `LiveVoiceChannelManager` (and its WebSocket / mic / playback
 * collaborators) never gets constructed in the test runner.
 *
 * The Zustand stores (`useAssistantFeatureFlagStore`, `useLiveVoiceStore`)
 * are imported as-is so we can drive them with `.setState()` — they're
 * module-scoped singletons but each test resets them in `beforeEach`.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { act, cleanup, fireEvent, render } from "@testing-library/react";

import type { LiveVoiceButtonManager } from "@/domains/voice/live-voice/live-voice-button";
import { LiveVoiceButton } from "@/domains/voice/live-voice/live-voice-button";
import { useLiveVoiceStore } from "@/domains/voice/live-voice/live-voice-store";
import { useAssistantFeatureFlagStore } from "@/lib/feature-flags/assistant-feature-flag-store";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/**
 * Records every call the button forwards to the manager so each test
 * can assert on (a) which method ran and (b) what payload it received.
 * Mirrors the fake-collaborator pattern used in
 * `live-voice-channel-manager.test.ts`.
 */
function createStubManager(): LiveVoiceButtonManager & {
  startCalls: string[];
  stopListeningCalls: number;
  interruptCalls: string[];
  endCalls: number;
} {
  const stub = {
    startCalls: [] as string[],
    stopListeningCalls: 0,
    interruptCalls: [] as string[],
    endCalls: 0,
    async start(conversationId: string) {
      stub.startCalls.push(conversationId);
    },
    async stopListening() {
      stub.stopListeningCalls += 1;
    },
    async interruptSpeakingAndStartListening(conversationId: string) {
      stub.interruptCalls.push(conversationId);
    },
    async end() {
      stub.endCalls += 1;
    },
  };
  return stub;
}

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

// The Button component renders to a real `<button>` so the test's
// `fireEvent.click` lands on the right handler — we mock it to a thin
// shell that forwards the `iconOnly` slot and ARIA attributes. Avoids
// pulling the design-library barrel (which imports Tailwind / radix
// modules) into the test process.
mock.module("@vellum/design-library", () => ({
  Button: ({
    iconOnly,
    onClick,
    disabled,
    "aria-label": ariaLabel,
    "aria-busy": ariaBusy,
    title,
  }: {
    iconOnly?: React.ReactNode;
    onClick?: () => void;
    disabled?: boolean;
    "aria-label"?: string;
    "aria-busy"?: boolean;
    title?: string;
  }) => (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      aria-busy={ariaBusy}
      title={title}
    >
      {iconOnly}
    </button>
  ),
}));

// ---------------------------------------------------------------------------
// Test scaffolding
// ---------------------------------------------------------------------------

const CONVERSATION_ID = "conv-123";
const ASSISTANT_ID = "asst-abc";

beforeEach(() => {
  // Reset Zustand singletons so each test starts from a clean slate.
  // `setState` with the full snapshot avoids mutating the action
  // closures the store holds onto.
  useLiveVoiceStore.setState({
    state: "off",
    sessionId: null,
    conversationId: null,
    partialTranscript: "",
    finalTranscript: "",
    assistantTranscript: "",
    inputAmplitude: 0,
    errorMessage: "",
  });
  useAssistantFeatureFlagStore.setState({ voiceMode: true });
});

afterEach(() => {
  cleanup();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("LiveVoiceButton — render gating", () => {
  test("(a) returns null when the voice-mode flag is off", () => {
    useAssistantFeatureFlagStore.setState({ voiceMode: false });
    const stub = createStubManager();
    const { container } = render(
      <LiveVoiceButton
        assistantId={ASSISTANT_ID}
        conversationId={CONVERSATION_ID}
        managerFactory={() => stub}
      />,
    );
    expect(container.innerHTML).toBe("");
  });

  test("(b) returns null when assistantId is null", () => {
    const stub = createStubManager();
    const { container } = render(
      <LiveVoiceButton
        assistantId={null}
        conversationId={CONVERSATION_ID}
        managerFactory={() => stub}
      />,
    );
    expect(container.innerHTML).toBe("");
  });

  test("(f) returns null even when assistantId is set if the flag is off", () => {
    // The flag check must short-circuit before the assistantId check —
    // a user without the flag should never see the button regardless of
    // which assistant they're on.
    useAssistantFeatureFlagStore.setState({ voiceMode: false });
    const stub = createStubManager();
    const { container } = render(
      <LiveVoiceButton
        assistantId={ASSISTANT_ID}
        conversationId={CONVERSATION_ID}
        managerFactory={() => stub}
      />,
    );
    expect(container.innerHTML).toBe("");
  });
});

describe("LiveVoiceButton — state → click handler", () => {
  test("(c) clicking the idle button calls manager.start(conversationId)", () => {
    const stub = createStubManager();
    const { getByRole } = render(
      <LiveVoiceButton
        assistantId={ASSISTANT_ID}
        conversationId={CONVERSATION_ID}
        managerFactory={() => stub}
      />,
    );
    fireEvent.click(getByRole("button"));
    expect(stub.startCalls).toEqual([CONVERSATION_ID]);
    expect(stub.stopListeningCalls).toBe(0);
    expect(stub.interruptCalls).toEqual([]);
  });

  test("(d) in `speaking` state, click calls interruptSpeakingAndStartListening", () => {
    const stub = createStubManager();
    const { getByRole } = render(
      <LiveVoiceButton
        assistantId={ASSISTANT_ID}
        conversationId={CONVERSATION_ID}
        managerFactory={() => stub}
      />,
    );
    // Drive the store into `speaking` — the component subscribes via
    // `useLiveVoiceStore.use.state()` so this triggers a re-render and
    // re-binds the click handler to `interruptSpeakingAndStartListening`.
    // Wrap in `act()` because the Zustand subscription schedules a React
    // state update inside the component.
    act(() => {
      useLiveVoiceStore.setState({ state: "speaking" });
    });
    fireEvent.click(getByRole("button"));
    expect(stub.interruptCalls).toEqual([CONVERSATION_ID]);
    expect(stub.startCalls).toEqual([]);
  });

  test("in `listening` state, click calls stopListening", () => {
    const stub = createStubManager();
    const { getByRole } = render(
      <LiveVoiceButton
        assistantId={ASSISTANT_ID}
        conversationId={CONVERSATION_ID}
        managerFactory={() => stub}
      />,
    );
    act(() => {
      useLiveVoiceStore.setState({ state: "listening" });
    });
    fireEvent.click(getByRole("button"));
    expect(stub.stopListeningCalls).toBe(1);
    expect(stub.startCalls).toEqual([]);
  });

  test("in `failed` state, click ends the session then starts a fresh one", async () => {
    const stub = createStubManager();
    const { getByRole } = render(
      <LiveVoiceButton
        assistantId={ASSISTANT_ID}
        conversationId={CONVERSATION_ID}
        managerFactory={() => stub}
      />,
    );
    act(() => {
      useLiveVoiceStore.setState({
        state: "failed",
        errorMessage: "connection lost",
      });
    });
    fireEvent.click(getByRole("button"));
    // Failed retry chains `end()` before `start()` so the next call
    // has a clean manager — yield to microtasks twice (one for the
    // awaited `end()`, one for the awaited `start()`) before asserting.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(stub.endCalls).toBeGreaterThanOrEqual(1);
    expect(stub.startCalls).toEqual([CONVERSATION_ID]);
  });
});

describe("LiveVoiceButton — lifecycle", () => {
  test("(e) unmounting calls manager.end()", () => {
    const stub = createStubManager();
    const { unmount } = render(
      <LiveVoiceButton
        assistantId={ASSISTANT_ID}
        conversationId={CONVERSATION_ID}
        managerFactory={() => stub}
      />,
    );
    expect(stub.endCalls).toBe(0);
    unmount();
    expect(stub.endCalls).toBe(1);
  });
});
