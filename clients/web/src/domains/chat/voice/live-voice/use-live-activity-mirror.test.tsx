/**
 * Tests for `useLiveActivityMirror` — the iOS Live Activity mirror of a
 * live-voice session.
 *
 * The `runtime/native-live-activity` bridge is stubbed at the module boundary
 * (rather than by faking `isNativeIOS`) so the mirror's own lifecycle and
 * throttling are asserted directly; the bridge's off-iOS and older-shell
 * behavior — every export resolving its fallback *without touching the
 * plugin* — is pinned by `runtime/native-live-activity.test.ts`, and the
 * mirror reaches native only through those exports.
 *
 * The avatar accent is *not* stubbed: the harness mounts the real
 * `useAvatarAccentVar` publisher (as `RootLayout` does), so these tests pin
 * that the island's accent is the same derivation the voice room renders.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";

import type { LiveVoiceSessionState } from "@/domains/chat/voice/live-voice/live-voice-store";
import type {
  VoiceLiveActivityContent,
  VoiceLiveActivityStart,
} from "@/runtime/native-live-activity";
import type { CharacterComponents, CharacterTraits } from "@/types/avatar";

// Typed to the real bridge signatures so the recorded payloads stay checked.
const startVoiceLiveActivity = mock(
  async (_options: VoiceLiveActivityStart): Promise<boolean> => true,
);
const updateVoiceLiveActivity = mock(
  async (_content: VoiceLiveActivityContent): Promise<void> => undefined,
);
const endVoiceLiveActivity = mock(async (): Promise<void> => undefined);

mock.module("@/runtime/native-live-activity", () => ({
  isVoiceLiveActivityAvailable: mock(async () => true),
  startVoiceLiveActivity,
  updateVoiceLiveActivity,
  endVoiceLiveActivity,
}));

const { useLiveActivityMirror } = await import(
  "@/domains/chat/voice/live-voice/use-live-activity-mirror"
);
const { useLiveVoiceStore } = await import(
  "@/domains/chat/voice/live-voice/live-voice-store"
);
const { useAvatarAccentVar } = await import("@/hooks/use-avatar-accent-var");
const { useAssistantIdentityStore } = await import(
  "@/stores/assistant-identity-store"
);
const { BUNDLED_COMPONENTS } = await import(
  "@/utils/avatar-bundled-components"
);

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const ORANGE = BUNDLED_COMPONENTS.colors.find((c) => c.id === "orange")!.hex;

const orangeTraits = {
  bodyShape: "blob",
  eyeStyle: "grumpy",
  color: "orange",
} as CharacterTraits;

interface Avatar {
  components: CharacterComponents | null;
  traits: CharacterTraits | null;
}

const ORANGE_AVATAR: Avatar = {
  components: BUNDLED_COMPONENTS,
  traits: orangeTraits,
};

/**
 * Mount the mirror behind the same accent publisher `RootLayout` mounts, so
 * `accentHex` resolves exactly as it does in the app.
 */
function renderMirror(avatar: Avatar = ORANGE_AVATAR) {
  return renderHook(
    ({ components, traits }: Avatar) => {
      useAvatarAccentVar(components, traits);
      useLiveActivityMirror();
    },
    { initialProps: avatar },
  );
}

/** Drive the store the way a session does, without any session machinery. */
function setPhase(state: LiveVoiceSessionState): void {
  act(() => {
    useLiveVoiceStore.getState().setState(state);
  });
}

function lastStartPayload() {
  return startVoiceLiveActivity.mock.calls.at(-1)?.[0];
}

function lastUpdatePayload() {
  return updateVoiceLiveActivity.mock.calls.at(-1)?.[0];
}

beforeEach(() => {
  useLiveVoiceStore.getState().reset();
  useAssistantIdentityStore.setState({
    name: "Ada",
    version: null,
    assistantId: "assistant-1",
  });
  startVoiceLiveActivity.mockClear();
  startVoiceLiveActivity.mockImplementation(async () => true);
  updateVoiceLiveActivity.mockClear();
  updateVoiceLiveActivity.mockImplementation(async () => {});
  endVoiceLiveActivity.mockClear();
  endVoiceLiveActivity.mockImplementation(async () => {});
});

afterEach(() => {
  cleanup();
  useLiveVoiceStore.getState().reset();
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

describe("starting the activity", () => {
  test("mounting with no session requests nothing", () => {
    renderMirror();

    expect(startVoiceLiveActivity).not.toHaveBeenCalled();
    expect(updateVoiceLiveActivity).not.toHaveBeenCalled();
    expect(endVoiceLiveActivity).not.toHaveBeenCalled();
  });

  test("starts exactly one activity when a session becomes active", () => {
    renderMirror();

    setPhase("connecting");

    expect(startVoiceLiveActivity).toHaveBeenCalledTimes(1);
    expect(lastStartPayload()).toEqual({
      phase: "connecting",
      label: "Connecting…",
      accentHex: ORANGE,
      muted: false,
      assistantName: "Ada",
    });
    expect(updateVoiceLiveActivity).not.toHaveBeenCalled();
  });

  test("a session already running at mount is picked up (controller remount)", () => {
    act(() => {
      useLiveVoiceStore.getState().setState("listening");
    });

    renderMirror();

    expect(startVoiceLiveActivity).toHaveBeenCalledTimes(1);
    expect(lastStartPayload()).toMatchObject({
      phase: "listening",
      label: "Listening…",
    });
  });

  test("falls back to the shared display name when the identity hasn't hydrated", () => {
    useAssistantIdentityStore.setState({
      name: null,
      version: null,
      assistantId: null,
    });
    renderMirror();

    setPhase("connecting");

    // Never empty — the native side rejects an empty `assistantName`.
    expect(lastStartPayload()?.assistantName).toBe("your assistant");
  });

  test("an avatar with no color to match sends an empty accent for the native neutral", () => {
    renderMirror({ components: null, traits: null });

    setPhase("connecting");

    expect(lastStartPayload()?.accentHex).toBe("");
  });

  test("a default (traits-less) avatar sends the color it actually renders", () => {
    renderMirror({ components: BUNDLED_COMPONENTS, traits: null });

    setPhase("connecting");

    expect(lastStartPayload()?.accentHex).toBe(BUNDLED_COMPONENTS.colors[0]!.hex);
  });
});

// ---------------------------------------------------------------------------
// Updates — exactly one per actual content change
// ---------------------------------------------------------------------------

describe("updating the activity", () => {
  test("pushes one update per phase change and none for a repeated phase", () => {
    renderMirror();
    setPhase("connecting");

    setPhase("listening");
    setPhase("thinking");
    setPhase("speaking");
    setPhase("listening");

    expect(updateVoiceLiveActivity).toHaveBeenCalledTimes(4);
    expect(lastUpdatePayload()).toEqual({
      phase: "listening",
      label: "Listening…",
      accentHex: ORANGE,
      muted: false,
    });

    // Re-publishing the same phase changes no `ContentState` field.
    setPhase("listening");
    expect(updateVoiceLiveActivity).toHaveBeenCalledTimes(4);
  });

  test("relabels to Reconnecting… exactly when the room does", () => {
    renderMirror();
    setPhase("connecting");

    act(() => {
      useLiveVoiceStore.getState().setReconnecting(true);
    });
    expect(updateVoiceLiveActivity).toHaveBeenCalledTimes(1);
    expect(lastUpdatePayload()?.label).toBe("Reconnecting…");

    // `reconnecting` is orthogonal to every other phase, so it must not
    // relabel one — and therefore must not spend an update either.
    setPhase("listening");
    expect(updateVoiceLiveActivity).toHaveBeenCalledTimes(2);
    expect(lastUpdatePayload()?.label).toBe("Listening…");

    act(() => {
      useLiveVoiceStore.getState().setReconnecting(false);
    });
    expect(updateVoiceLiveActivity).toHaveBeenCalledTimes(2);
  });

  test("pushes muting and unmuting", () => {
    renderMirror();
    setPhase("listening");

    act(() => {
      useLiveVoiceStore.getState().setMuted(true);
    });
    expect(lastUpdatePayload()?.muted).toBe(true);

    act(() => {
      useLiveVoiceStore.getState().setMuted(true);
    });
    expect(updateVoiceLiveActivity).toHaveBeenCalledTimes(1);

    act(() => {
      useLiveVoiceStore.getState().setMuted(false);
    });
    expect(updateVoiceLiveActivity).toHaveBeenCalledTimes(2);
    expect(lastUpdatePayload()?.muted).toBe(false);
  });

  test("amplitude and transcript churn pushes nothing", () => {
    renderMirror();
    setPhase("listening");

    // What a single second of a live session emits. ActivityKit's update
    // budget would be gone instantly if any of it reached the bridge.
    act(() => {
      const store = useLiveVoiceStore.getState();
      for (let i = 0; i < 60; i += 1) {
        store.setInputAmplitude(i / 60);
      }
      store.setPartialTranscript("hello");
      store.appendAssistantTranscript("hi");
      store.setAssistantAudioActive(true);
      store.setLastTurnLatency({ server: null, clientHeardLatencyMs: 120 });
    });

    expect(updateVoiceLiveActivity).not.toHaveBeenCalled();
    expect(startVoiceLiveActivity).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Ending
// ---------------------------------------------------------------------------

describe("ending the activity", () => {
  test("ends when the session goes idle", () => {
    renderMirror();
    setPhase("listening");

    act(() => {
      useLiveVoiceStore.getState().reset();
    });

    expect(useLiveVoiceStore.getState().state).toBe("idle");
    expect(endVoiceLiveActivity).toHaveBeenCalledTimes(1);
  });

  test("ends when the session fails rather than showing a dead island", () => {
    renderMirror();
    setPhase("listening");

    act(() => {
      useLiveVoiceStore.getState().fail("velay unreachable");
    });

    expect(endVoiceLiveActivity).toHaveBeenCalledTimes(1);
    expect(updateVoiceLiveActivity).not.toHaveBeenCalled();
  });

  test("ends only once, however the session settles", () => {
    renderMirror();
    setPhase("listening");
    setPhase("ending");

    act(() => {
      useLiveVoiceStore.getState().reset();
      useLiveVoiceStore.getState().setState("idle");
    });

    expect(endVoiceLiveActivity).toHaveBeenCalledTimes(1);
  });

  test("ends on unmount so no island outlives its mirror", () => {
    const view = renderMirror();
    setPhase("listening");

    act(() => {
      view.unmount();
    });

    expect(endVoiceLiveActivity).toHaveBeenCalledTimes(1);
  });

  test("unmounting without an activity ends nothing", () => {
    const view = renderMirror();

    act(() => {
      view.unmount();
    });

    expect(endVoiceLiveActivity).not.toHaveBeenCalled();
  });

  test("a second session after the first ends starts a fresh activity", () => {
    renderMirror();
    setPhase("listening");
    act(() => {
      useLiveVoiceStore.getState().reset();
    });

    setPhase("connecting");

    expect(startVoiceLiveActivity).toHaveBeenCalledTimes(2);
    expect(endVoiceLiveActivity).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Skew — an older App Store shell, or a bridge that simply fails
// ---------------------------------------------------------------------------

describe("a failing bridge", () => {
  test("never reaches the session", () => {
    const rejection = () => {
      throw new Error("VoiceLiveActivity does not have web implementation.");
    };
    startVoiceLiveActivity.mockImplementation(async () => rejection());
    updateVoiceLiveActivity.mockImplementation(async () => rejection());
    endVoiceLiveActivity.mockImplementation(async () => rejection());

    const view = renderMirror();
    setPhase("connecting");
    setPhase("listening");
    expect(useLiveVoiceStore.getState().state).toBe("listening");

    act(() => {
      useLiveVoiceStore.getState().reset();
      view.unmount();
    });

    // The session ran to completion, and every rejection was swallowed.
    expect(startVoiceLiveActivity).toHaveBeenCalledTimes(1);
    expect(updateVoiceLiveActivity).toHaveBeenCalledTimes(1);
    expect(endVoiceLiveActivity).toHaveBeenCalledTimes(1);
    expect(useLiveVoiceStore.getState().state).toBe("idle");
  });
});
