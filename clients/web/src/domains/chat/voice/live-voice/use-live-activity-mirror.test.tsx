/**
 * Tests for `useLiveActivityMirror`, the out-of-app mirror of a live-voice
 * session, feeding the iOS Live Activity and the macOS floating panel from one
 * snapshot.
 *
 * The `runtime/native-live-activity` bridge is stubbed at the module boundary
 * (rather than by faking `isNativeIOS`) so the mirror's own lifecycle and
 * throttling are asserted directly; the bridge's off-iOS and older-shell
 * behavior — every export resolving its fallback *without touching the
 * plugin*, and never rejecting — is pinned by
 * `runtime/native-live-activity.test.ts`, and the mirror reaches native only
 * through those exports.
 *
 * The avatar accent is *not* stubbed: the harness mounts the real
 * `useAvatarAccentVar` publisher (as `RootLayout` does), so these tests pin
 * that the island's accent is the same derivation the voice room renders.
 *
 * Every store write here is `await`ed because the mirror observes *settled*
 * state — it coalesces each synchronous burst of `set()` calls into one
 * microtask — so a push lands a microtask after the write.
 *
 * `start` is additionally asynchronous in its own right: it resolves the
 * avatar before requesting the activity. No avatar source is published here
 * (`RootLayout` owns that publisher), so these tests exercise the
 * no-avatar path and only need the settle they already do.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";

import type { LiveVoiceSessionState } from "@/domains/chat/voice/live-voice/live-voice-store";
import type {
  VoiceLiveActivityContent,
  VoiceLiveActivityStart,
} from "@/runtime/native-live-activity";
import type {
  VoiceActivityContent,
  VoiceActivityStart,
} from "@/runtime/is-electron";
import type { CharacterComponents, CharacterTraits } from "@/types/avatar";

// Typed to the real bridge signatures so the recorded payloads stay checked.
const startVoiceLiveActivity = mock(
  async (_options: VoiceLiveActivityStart): Promise<boolean> => true,
);
const updateVoiceLiveActivity = mock(
  async (_content: VoiceLiveActivityContent): Promise<void> => undefined,
);
const endVoiceLiveActivity = mock(async (): Promise<void> => undefined);

// The ActivityKit push token and its platform registration — the path that
// keeps the island updating once iOS suspends this web layer. Held here so a
// test can hand the mirror a token and assert what it registers.
let emitPushToken: ((event: { token: string }) => void) | null = null;
const subscribeVoiceLiveActivityPushToken = mock(
  (handler: (event: { token: string }) => void): (() => void) => {
    emitPushToken = handler;
    return () => {
      emitPushToken = null;
    };
  },
);
const registerLiveActivityPushToken = mock(
  async (_registration: {
    token: string;
    assistantId: string;
    conversationId: string;
    accentHex: string;
    muted: boolean;
  }): Promise<void> => undefined,
);
const unregisterLiveActivityPushToken = mock(
  async (): Promise<void> => undefined,
);

// Holds the avatar encode open so a phase change can land between `start`
// being requested and the bridge actually being called. Stubbed rather than
// delegating to the real encoder: the real one needs a canvas, and importing
// the module here in order to wrap it deadlocks module init.
let encodeGate: Promise<void> | null = null;

mock.module("@/utils/avatar-island-encode", () => ({
  ISLAND_AVATAR_MAX_BYTES: 2000,
  encodeAvatarForIsland: async () => {
    if (encodeGate) {
      await encodeGate;
    }
    return null;
  },
}));

mock.module("@/hooks/use-island-avatar-source", () => ({
  useIslandAvatarSource: () => undefined,
  getIslandAvatarSource: () => ({
    kind: "character",
    svg: "<svg/>",
    dataUri: "d",
  }),
}));

mock.module("@/runtime/native-live-activity", () => ({
  startVoiceLiveActivity,
  updateVoiceLiveActivity,
  endVoiceLiveActivity,
  subscribeVoiceLiveActivityPushToken,
}));

// The desktop sink: the Electron floating panel's half of the same mirror.
// Stubbed at the same boundary as the mobile bridge, and for the same reason:
// its own off-Electron behavior is the runtime module's to pin, while what
// matters here is that both sinks are driven from one snapshot.
const startVoiceActivity = mock(
  (_state: VoiceActivityStart): void => undefined,
);
const updateVoiceActivity = mock(
  (_content: VoiceActivityContent): void => undefined,
);
const endVoiceActivity = mock((): void => undefined);

mock.module("@/runtime/desktop-voice-activity", () => ({
  startVoiceActivity,
  updateVoiceActivity,
  endVoiceActivity,
}));

mock.module(
  "@/domains/chat/voice/live-voice/live-activity-push-registration",
  () => ({
    registerLiveActivityPushToken,
    unregisterLiveActivityPushToken,
  }),
);

const { useLiveActivityMirror } =
  await import("@/domains/chat/voice/live-voice/use-live-activity-mirror");
const { useLiveVoiceStore } =
  await import("@/domains/chat/voice/live-voice/live-voice-store");
const { useAvatarAccentVar } = await import("@/hooks/use-avatar-accent-var");
const { useAssistantIdentityStore } =
  await import("@/stores/assistant-identity-store");
const { BUNDLED_COMPONENTS } =
  await import("@/utils/avatar-bundled-components");

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
      useAvatarAccentVar(components, traits, null);
      useLiveActivityMirror();
    },
    { initialProps: avatar },
  );
}

/** Run a synchronous store burst, then let the mirror's coalescing microtask run. */
async function settled(mutate: () => void = () => undefined): Promise<void> {
  await act(async () => {
    mutate();
  });
}

/** Drive the store the way a session does, without any session machinery. */
async function setPhase(state: LiveVoiceSessionState): Promise<void> {
  await settled(() => useLiveVoiceStore.getState().setState(state));
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
  subscribeVoiceLiveActivityPushToken.mockClear();
  registerLiveActivityPushToken.mockClear();
  unregisterLiveActivityPushToken.mockClear();
  startVoiceActivity.mockClear();
  updateVoiceActivity.mockClear();
  endVoiceActivity.mockClear();
  emitPushToken = null;
});

afterEach(() => {
  cleanup();
  useLiveVoiceStore.getState().reset();
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

describe("starting the activity", () => {
  test("mounting with no session requests nothing", async () => {
    renderMirror();
    await settled();

    expect(startVoiceLiveActivity).not.toHaveBeenCalled();
    expect(updateVoiceLiveActivity).not.toHaveBeenCalled();
    expect(endVoiceLiveActivity).not.toHaveBeenCalled();
  });

  test("starts exactly one activity when a session becomes active", async () => {
    renderMirror();

    await setPhase("connecting");

    expect(startVoiceLiveActivity).toHaveBeenCalledTimes(1);
    expect(lastStartPayload()).toEqual({
      phase: "connecting",
      label: "Connecting…",
      accentHex: ORANGE,
      muted: false,
      outputMuted: false,
      detail: "",
      approvalRequestId: "",
      assistantName: "Ada",
    });
    expect(updateVoiceLiveActivity).not.toHaveBeenCalled();
  });

  // The encode is a canvas draw, so `start` is not synchronous with the store
  // transition that requested it. A phase landing inside that window pushes an
  // `update` the native side drops for want of an activity to update, so the
  // island would open on the stale phase and stay there until something else
  // changed.
  test("opens on the newest phase when one lands during the avatar encode", async () => {
    let openGate = () => undefined as void;
    encodeGate = new Promise<void>((resolve) => {
      openGate = () => {
        resolve();
      };
    });

    renderMirror();
    await setPhase("connecting");
    expect(startVoiceLiveActivity).not.toHaveBeenCalled();

    // Moves on while the encode is still pending.
    await setPhase("listening");

    await act(async () => {
      openGate();
      await Promise.resolve();
    });

    expect(startVoiceLiveActivity).toHaveBeenCalledTimes(1);
    expect(lastStartPayload()).toMatchObject({ phase: "listening" });
    encodeGate = null;
  });

  // The same window, but the session ends inside it. A late `start` would
  // strand an island that only the next launch could clear.
  test("does not start at all when the session ends during the encode", async () => {
    let openGate = () => undefined as void;
    encodeGate = new Promise<void>((resolve) => {
      openGate = () => {
        resolve();
      };
    });

    renderMirror();
    await setPhase("connecting");
    await setPhase("idle");

    await act(async () => {
      openGate();
      await Promise.resolve();
    });

    expect(startVoiceLiveActivity).not.toHaveBeenCalled();
    encodeGate = null;
  });

  test("a session already running at mount is picked up (controller remount)", async () => {
    await settled(() => useLiveVoiceStore.getState().setState("listening"));

    renderMirror();
    // `start` resolves the avatar before it fires, so the mount-time pickup
    // lands a microtask later than the render.
    await settled();

    expect(startVoiceLiveActivity).toHaveBeenCalledTimes(1);
    expect(lastStartPayload()).toMatchObject({
      phase: "listening",
      label: "Listening…",
    });
  });

  test("falls back to the shared display name when the identity hasn't hydrated", async () => {
    useAssistantIdentityStore.setState({
      name: null,
      version: null,
      assistantId: null,
    });
    renderMirror();

    await setPhase("connecting");

    // Never empty — the native side rejects an empty `assistantName`.
    expect(lastStartPayload()?.assistantName).toBe("your assistant");
  });

  test("an avatar with no color to match sends an empty accent for the native neutral", async () => {
    renderMirror({ components: null, traits: null });

    await setPhase("connecting");

    expect(lastStartPayload()?.accentHex).toBe("");
  });

  test("a default (traits-less) avatar sends the color it actually renders", async () => {
    renderMirror({ components: BUNDLED_COMPONENTS, traits: null });

    await setPhase("connecting");

    expect(lastStartPayload()?.accentHex).toBe(
      BUNDLED_COMPONENTS.colors[0]!.hex,
    );
  });
});

// ---------------------------------------------------------------------------
// Updates — exactly one per actual content change
// ---------------------------------------------------------------------------

describe("updating the activity", () => {
  test("pushes the activity line the daemon worded", async () => {
    renderMirror();
    await setPhase("thinking");
    updateVoiceLiveActivity.mockClear();

    await settled(() => {
      useLiveVoiceStore.getState().setActivityLabel("Reading a file");
    });

    expect(lastUpdatePayload()?.detail).toBe("Reading a file");
  });

  test("clears the line when the turn stops working", async () => {
    renderMirror();
    await setPhase("thinking");
    await settled(() => {
      useLiveVoiceStore.getState().setActivityLabel("Reading a file");
    });
    updateVoiceLiveActivity.mockClear();

    await settled(() => {
      useLiveVoiceStore.getState().setActivityLabel("");
    });

    expect(lastUpdatePayload()?.detail).toBe("");
  });

  test("pushes one update per phase change and none for a repeated phase", async () => {
    renderMirror();
    await setPhase("connecting");

    await setPhase("listening");
    await setPhase("thinking");
    await setPhase("speaking");
    await setPhase("listening");

    expect(updateVoiceLiveActivity).toHaveBeenCalledTimes(4);
    expect(lastUpdatePayload()).toEqual({
      phase: "listening",
      label: "Listening…",
      accentHex: ORANGE,
      muted: false,
      outputMuted: false,
      detail: "",
      approvalRequestId: "",
    });

    // Re-publishing the same phase changes no `ContentState` field.
    await setPhase("listening");
    expect(updateVoiceLiveActivity).toHaveBeenCalledTimes(4);
  });

  test("relabels to Reconnecting… exactly when the room does", async () => {
    renderMirror();
    await setPhase("connecting");

    await settled(() => useLiveVoiceStore.getState().setReconnecting(true));
    expect(updateVoiceLiveActivity).toHaveBeenCalledTimes(1);
    expect(lastUpdatePayload()?.label).toBe("Reconnecting…");

    // `reconnecting` is orthogonal to every other phase, so it must not
    // relabel one — and therefore must not spend an update either.
    await setPhase("listening");
    expect(updateVoiceLiveActivity).toHaveBeenCalledTimes(2);
    expect(lastUpdatePayload()?.label).toBe("Listening…");

    await settled(() => useLiveVoiceStore.getState().setReconnecting(false));
    expect(updateVoiceLiveActivity).toHaveBeenCalledTimes(2);
  });

  test("pushes muting and unmuting", async () => {
    renderMirror();
    await setPhase("listening");

    await settled(() => useLiveVoiceStore.getState().setMuted(true));
    expect(lastUpdatePayload()?.muted).toBe(true);

    await settled(() => useLiveVoiceStore.getState().setMuted(true));
    expect(updateVoiceLiveActivity).toHaveBeenCalledTimes(1);

    await settled(() => useLiveVoiceStore.getState().setMuted(false));
    expect(updateVoiceLiveActivity).toHaveBeenCalledTimes(2);
    expect(lastUpdatePayload()?.muted).toBe(false);
  });

  test("pushes the assistant's mute, the other direction of the same pair", async () => {
    // The island's speaker button is rendered against this. It is the one
    // content field the APNs path cannot compose (the push registration does
    // not carry it), which makes the local push the only thing that ever
    // gets it right.
    renderMirror();
    await setPhase("listening");

    await settled(() => useLiveVoiceStore.getState().setOutputMuted(true));
    expect(updateVoiceLiveActivity).toHaveBeenCalledTimes(1);
    expect(lastUpdatePayload()?.outputMuted).toBe(true);

    await settled(() => useLiveVoiceStore.getState().setOutputMuted(true));
    expect(updateVoiceLiveActivity).toHaveBeenCalledTimes(1);

    await settled(() => useLiveVoiceStore.getState().setOutputMuted(false));
    expect(updateVoiceLiveActivity).toHaveBeenCalledTimes(2);
    expect(lastUpdatePayload()?.outputMuted).toBe(false);
  });

  test("amplitude and transcript churn pushes nothing", async () => {
    renderMirror();
    await setPhase("listening");

    // What a single second of a live session emits. ActivityKit's update
    // budget would be gone instantly if any of it reached the bridge.
    // `assistantAudioActive` is an input to the label, but only for the
    // `speaking` phase (see below); while listening it is as inert as the
    // amplitude.
    await settled(() => {
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

  // The label is the room's label, and the room does not say "Speaking…" while
  // nothing is audible: `speaking` stays set across a mid-turn tool run, so the
  // ack-then-silence window reads as "Thinking…" (JARVIS-1279). An island that
  // disagreed with the room the user taps through to would be a bug.
  test("a silent mid-turn speaking reads as Thinking…, exactly as the room does", async () => {
    renderMirror();
    await setPhase("listening");

    await setPhase("speaking");
    expect(lastUpdatePayload()).toMatchObject({
      phase: "speaking",
      label: "Thinking…",
    });

    // TTS audio actually starts.
    await settled(() =>
      useLiveVoiceStore.getState().setAssistantAudioActive(true),
    );
    expect(lastUpdatePayload()).toMatchObject({
      phase: "speaking",
      label: "Speaking…",
    });

    // …and drains while the phase is still `speaking` (a tool now running).
    await settled(() =>
      useLiveVoiceStore.getState().setAssistantAudioActive(false),
    );
    expect(lastUpdatePayload()?.label).toBe("Thinking…");
  });
});

// ---------------------------------------------------------------------------
// Reconnects — the store passes through idle, the island must not
// ---------------------------------------------------------------------------

describe("a hands-free reconnect", () => {
  /**
   * What `connectSession` does when the backoff timer re-enters it: a full
   * `reset()` (which lands on `idle`) immediately superseded by the rebuilt
   * `connecting` session, all in one synchronous burst.
   */
  function reconnectBurst(): void {
    const store = useLiveVoiceStore.getState();
    store.reset();
    store.setState("connecting");
    store.setReconnecting(true);
    store.setSessionContext("assistant-1", "conv-1");
    store.setMuted(true);
  }

  test("reset() immediately superseded by connecting never reaches the bridge", async () => {
    renderMirror();
    await setPhase("listening");
    updateVoiceLiveActivity.mockClear();

    await settled(reconnectBurst);

    // The island must not disappear and reappear on every retry: no `end`, and
    // no second `start` requesting a fresh activity.
    expect(endVoiceLiveActivity).not.toHaveBeenCalled();
    expect(startVoiceLiveActivity).toHaveBeenCalledTimes(1);
  });

  test("the whole burst costs exactly one update, at the settled content", async () => {
    renderMirror();
    await setPhase("listening");
    updateVoiceLiveActivity.mockClear();

    await settled(reconnectBurst);

    // One push, not one per `set()` — and it carries the muted flag the
    // reconnect re-applied, so the mute glyph never flickers off and back on.
    expect(updateVoiceLiveActivity).toHaveBeenCalledTimes(1);
    expect(lastUpdatePayload()).toEqual({
      phase: "connecting",
      label: "Reconnecting…",
      accentHex: ORANGE,
      muted: true,
      outputMuted: false,
      detail: "",
      approvalRequestId: "",
    });
  });
});

// ---------------------------------------------------------------------------
// Ending
// ---------------------------------------------------------------------------

describe("ending the activity", () => {
  test("ends when the session goes idle", async () => {
    renderMirror();
    await setPhase("listening");

    await settled(() => useLiveVoiceStore.getState().reset());

    expect(useLiveVoiceStore.getState().state).toBe("idle");
    expect(endVoiceLiveActivity).toHaveBeenCalledTimes(1);
  });

  test("ends when the session fails rather than showing a dead island", async () => {
    renderMirror();
    await setPhase("listening");

    await settled(() => useLiveVoiceStore.getState().fail("velay unreachable"));

    expect(endVoiceLiveActivity).toHaveBeenCalledTimes(1);
    expect(updateVoiceLiveActivity).not.toHaveBeenCalled();
  });

  test("ends only once, however the session settles", async () => {
    renderMirror();
    await setPhase("listening");
    await setPhase("ending");

    await settled(() => {
      useLiveVoiceStore.getState().reset();
      useLiveVoiceStore.getState().setState("idle");
    });

    expect(endVoiceLiveActivity).toHaveBeenCalledTimes(1);
  });

  test("ends on unmount so no island outlives its mirror", async () => {
    const view = renderMirror();
    await setPhase("listening");

    act(() => {
      view.unmount();
    });

    expect(endVoiceLiveActivity).toHaveBeenCalledTimes(1);
  });

  test("unmounting without an activity ends nothing", async () => {
    const view = renderMirror();

    act(() => {
      view.unmount();
    });
    await settled();

    expect(endVoiceLiveActivity).not.toHaveBeenCalled();
  });

  test("a second session after the first ends starts a fresh activity", async () => {
    renderMirror();
    await setPhase("listening");
    await settled(() => useLiveVoiceStore.getState().reset());

    await setPhase("connecting");

    expect(startVoiceLiveActivity).toHaveBeenCalledTimes(2);
    expect(endVoiceLiveActivity).toHaveBeenCalledTimes(1);
  });

  test("an unmount in the same tick as a store write wins", async () => {
    const view = renderMirror();
    await setPhase("listening");

    await act(async () => {
      // The mirror's own teardown is authoritative: the coalesced read must
      // not fire after it and leave an island nothing is driving.
      useLiveVoiceStore.getState().setState("thinking");
      view.unmount();
    });

    expect(endVoiceLiveActivity).toHaveBeenCalledTimes(1);
    expect(startVoiceLiveActivity).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Skew — an older App Store shell, where there is no plugin behind the bridge
// ---------------------------------------------------------------------------

describe("a bridge with nothing behind it", () => {
  test("never reaches the session", async () => {
    // What the real module resolves on an older shell (and off iOS): its
    // fallback, never a rejection — `callNativeVoice` swallows the "no web
    // implementation" error, which `runtime/native-live-activity.test.ts` pins
    // directly.
    startVoiceLiveActivity.mockImplementation(async () => false);

    const view = renderMirror();
    await setPhase("connecting");
    await setPhase("listening");
    expect(useLiveVoiceStore.getState().state).toBe("listening");

    await act(async () => {
      useLiveVoiceStore.getState().reset();
      view.unmount();
    });

    // The session ran to completion, and the mirror kept sequencing off its
    // own intent rather than the bridge's answer.
    expect(startVoiceLiveActivity).toHaveBeenCalledTimes(1);
    expect(updateVoiceLiveActivity).toHaveBeenCalledTimes(1);
    expect(endVoiceLiveActivity).toHaveBeenCalledTimes(1);
    expect(useLiveVoiceStore.getState().state).toBe("idle");
  });
});

// ---------------------------------------------------------------------------
// Push-token registration
// ---------------------------------------------------------------------------

// The local push path above runs on a JS main thread iOS suspends once the app
// is backgrounded — which is the only state the island is ever seen in.
// Registering the activity's ActivityKit token is what gives the same activity
// a driver that does not need this web layer to be running.
describe("registering the activity for server-driven updates", () => {
  /** Hand the mirror a token the way ActivityKit does, after `start`. */
  async function emitToken(token: string): Promise<void> {
    await act(async () => {
      emitPushToken?.({ token });
    });
  }

  test("registers the token against the running session", async () => {
    renderMirror();
    await settled(() => {
      useLiveVoiceStore.getState().setSessionContext("assistant-1", "conv-1");
      useLiveVoiceStore.getState().setState("listening");
    });

    await emitToken("token-abc");

    expect(registerLiveActivityPushToken).toHaveBeenCalledTimes(1);
    expect(registerLiveActivityPushToken.mock.calls.at(-1)).toEqual([
      {
        token: "token-abc",
        assistantId: "assistant-1",
        conversationId: "conv-1",
        accentHex: ORANGE,
        muted: false,
      },
    ]);
  });

  // A session started from a draft has no conversation id until the server's
  // `ready` assigns one. Registering against nothing and never revisiting it
  // would leave the activity addressable by no one.
  test("waits for the conversation id, then registers", async () => {
    renderMirror();
    await setPhase("connecting");

    await emitToken("token-abc");
    expect(registerLiveActivityPushToken).not.toHaveBeenCalled();

    await settled(() => {
      useLiveVoiceStore.getState().setSessionContext("assistant-1", "conv-9");
    });

    expect(registerLiveActivityPushToken).toHaveBeenCalledTimes(1);
    expect(registerLiveActivityPushToken.mock.calls.at(-1)?.[0]).toMatchObject(
      { conversationId: "conv-9" },
    );
  });

  // iOS reissues tokens mid-activity and each value invalidates the last, so a
  // rotation the platform never hears about leaves it pushing at a token APNs
  // has stopped honouring.
  test("re-registers when the token rotates", async () => {
    renderMirror();
    await settled(() => {
      useLiveVoiceStore.getState().setSessionContext("assistant-1", "conv-1");
      useLiveVoiceStore.getState().setState("listening");
    });

    await emitToken("token-abc");
    await emitToken("token-def");

    expect(registerLiveActivityPushToken).toHaveBeenCalledTimes(2);
    expect(registerLiveActivityPushToken.mock.calls.at(-1)?.[0]).toMatchObject(
      { token: "token-def" },
    );
  });

  // The platform composes every push from the registration, so a mute the
  // registration never heard about is a mute the island loses the moment a
  // server-driven update lands, which is to say the moment it matters.
  test("re-registers when the mute state changes", async () => {
    renderMirror();
    await settled(() => {
      useLiveVoiceStore.getState().setSessionContext("assistant-1", "conv-1");
      useLiveVoiceStore.getState().setState("listening");
    });
    await emitToken("token-abc");
    registerLiveActivityPushToken.mockClear();

    await settled(() => {
      useLiveVoiceStore.getState().setMuted(true);
    });

    expect(registerLiveActivityPushToken).toHaveBeenCalledTimes(1);
    expect(registerLiveActivityPushToken.mock.calls.at(-1)?.[0]).toMatchObject({
      muted: true,
    });
  });

  test("a phase change alone does not re-register", async () => {
    renderMirror();
    await settled(() => {
      useLiveVoiceStore.getState().setSessionContext("assistant-1", "conv-1");
      useLiveVoiceStore.getState().setState("listening");
    });
    await emitToken("token-abc");
    registerLiveActivityPushToken.mockClear();

    await setPhase("thinking");
    await setPhase("speaking");

    expect(registerLiveActivityPushToken).not.toHaveBeenCalled();
  });

  // A registration that outlives its activity lets the platform push a phase
  // at an island that no longer exists.
  test("retires the registration when the session ends", async () => {
    renderMirror();
    await settled(() => {
      useLiveVoiceStore.getState().setSessionContext("assistant-1", "conv-1");
      useLiveVoiceStore.getState().setState("listening");
    });
    await emitToken("token-abc");

    await setPhase("idle");

    expect(unregisterLiveActivityPushToken).toHaveBeenCalledTimes(1);
  });

  test("retires the registration when the mirror unmounts", async () => {
    const view = renderMirror();
    await settled(() => {
      useLiveVoiceStore.getState().setSessionContext("assistant-1", "conv-1");
      useLiveVoiceStore.getState().setState("listening");
    });
    await emitToken("token-abc");

    await act(async () => {
      view.unmount();
    });

    expect(unregisterLiveActivityPushToken).toHaveBeenCalledTimes(1);
  });

  test("no session means nothing is registered", async () => {
    renderMirror();
    await settled();

    await emitToken("token-abc");

    expect(registerLiveActivityPushToken).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// The desktop sink
// ---------------------------------------------------------------------------

/**
 * The floating panel is fed by the same mirror as the island, from the same
 * computed snapshot. These pin the fan-out itself (that both sinks see one
 * payload, on one schedule) rather than re-testing the content rules above,
 * which are sink-agnostic by construction.
 */
describe("the desktop panel sink", () => {
  test("start reaches both sinks with the identical payload", async () => {
    renderMirror();

    await setPhase("connecting");

    expect(startVoiceActivity).toHaveBeenCalledTimes(1);
    expect(startVoiceActivity.mock.calls.at(-1)?.[0]).toEqual(
      lastStartPayload() as VoiceActivityStart,
    );
  });

  test("updates are pushed to the panel on the island's schedule", async () => {
    renderMirror();
    await setPhase("connecting");

    await setPhase("listening");

    expect(updateVoiceActivity).toHaveBeenCalledTimes(1);
    expect(updateVoiceActivity.mock.calls.at(-1)?.[0]).toEqual(
      lastUpdatePayload() as VoiceActivityContent,
    );
  });

  test("content that would not move the island does not reach the panel either", async () => {
    renderMirror();
    await setPhase("connecting");
    updateVoiceActivity.mockClear();

    // A store write the mirror deliberately ignores: same phase, same label,
    // same everything a surface renders.
    await settled(() => {
      useLiveVoiceStore.getState().setState("connecting");
    });

    expect(updateVoiceActivity).not.toHaveBeenCalled();
  });

  test("ending the session dismisses the panel", async () => {
    renderMirror();
    await setPhase("listening");

    await setPhase("idle");

    expect(endVoiceActivity).toHaveBeenCalledTimes(1);
  });

  test("unmounting the mirror dismisses the panel", async () => {
    const view = renderMirror();
    await setPhase("listening");

    await act(async () => {
      view.unmount();
    });

    // A panel that outlives its mirror floats over the desktop showing a phase
    // nothing is driving.
    expect(endVoiceActivity).toHaveBeenCalledTimes(1);
  });
});
