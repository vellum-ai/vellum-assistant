/**
 * Tests for the TalkingHead.js-backed avatar renderer.
 *
 * The renderer delegates every interesting operation to the Chrome
 * extension over the native-messaging bridge, so tests mock the
 * {@link AvatarNativeMessagingSender} surface entirely — no real
 * socket server or Chrome process is needed.
 *
 * Coverage:
 *   - `start()` sends `avatar.start` over native messaging and waits
 *     for the extension's `avatar.started` ack.
 *   - `start()` throws `AvatarRendererUnavailableError` when the ack
 *     doesn't arrive within the bounded timeout.
 *   - `pushViseme` forwards the event as `avatar.push_viseme`.
 *   - Inbound `avatar.frame` (JPEG) re-emits via `onFrame` after a
 *     (mocked) ffmpeg transcode.
 *   - Inbound `avatar.frame` (Y4M) re-emits via `onFrame` directly.
 *   - `stop()` sends `avatar.stop`, is idempotent, and cancels the
 *     pending ack waiter if invoked mid-start.
 *   - Factory registration throws `AvatarRendererUnavailableError`
 *     when `deps.nativeMessaging` is absent.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type {
  BotAvatarPushVisemeCommand,
  BotAvatarStartCommand,
  BotAvatarStopCommand,
  ExtensionAvatarFrameMessage,
  ExtensionAvatarStartedMessage,
  ExtensionToBotMessage,
} from "../../contracts/native-messaging.js";
import {
  AvatarRendererUnavailableError,
  __resetAvatarRegistryForTests,
  isAvatarRendererRegistered,
  registerAvatarRenderer,
  resolveAvatarRenderer,
  type AvatarConfig,
  type AvatarNativeMessagingSender,
  type AvatarRendererDeps,
  type Y4MFrame,
} from "../src/media/avatar/index.js";
// Importing the talking-head module has the side effect of registering
// the factory with the registry.
import "../src/media/avatar/talking-head/index.js";
import {
  TALKING_HEAD_RENDERER_ID,
  TalkingHeadRenderer,
  type JpegToY4mSpawnFactory,
} from "../src/media/avatar/talking-head/renderer.js";

/**
 * Rebuild the talking-head factory registration after a sibling test
 * suite (e.g. `avatar-registry.test.ts`) called
 * `__resetAvatarRegistryForTests`. The factory module only self-
 * registers on first import; ES modules cache and don't re-run on a
 * subsequent import. We re-import the module dynamically isn't an
 * option for the same reason, so we just register the factory
 * ourselves using the same public surface the module uses.
 */
function ensureTalkingHeadRegistered(): void {
  if (isAvatarRendererRegistered(TALKING_HEAD_RENDERER_ID)) return;
  registerAvatarRenderer(
    TALKING_HEAD_RENDERER_ID,
    (config: AvatarConfig, deps: AvatarRendererDeps) => {
      if (!deps.nativeMessaging) {
        throw new AvatarRendererUnavailableError(
          TALKING_HEAD_RENDERER_ID,
          "native-messaging surface not wired (bot was booted without an NMH socket server)",
        );
      }
      const rawSub = (config as Record<string, unknown>).talkingHead;
      const sub =
        rawSub && typeof rawSub === "object"
          ? (rawSub as Record<string, unknown>)
          : {};
      const opts: ConstructorParameters<typeof TalkingHeadRenderer>[0] = {
        nativeMessaging: deps.nativeMessaging,
      };
      if (typeof sub.modelUrl === "string") opts.modelUrl = sub.modelUrl;
      else if (typeof sub.modelPath === "string") opts.modelUrl = sub.modelPath;
      if (typeof sub.targetFps === "number") opts.targetFps = sub.targetFps;
      if (typeof sub.startedAckTimeoutMs === "number")
        opts.startedAckTimeoutMs = sub.startedAckTimeoutMs;
      return new TalkingHeadRenderer(opts);
    },
  );
}

type BotAvatarMsg =
  | BotAvatarStartCommand
  | BotAvatarStopCommand
  | BotAvatarPushVisemeCommand;

/**
 * In-memory fake of the `AvatarNativeMessagingSender` surface the
 * renderer depends on. Records every outbound message and exposes an
 * `emit(...)` helper that drives the registered inbound listeners
 * deterministically.
 */
class FakeNativeMessaging implements AvatarNativeMessagingSender {
  readonly sent: BotAvatarMsg[] = [];
  private listeners: Array<(msg: ExtensionToBotMessage) => void> = [];

  sendToExtension = (msg: BotAvatarMsg): void => {
    this.sent.push(msg);
  };

  onExtensionMessage = (cb: (msg: ExtensionToBotMessage) => void): void => {
    this.listeners.push(cb);
  };

  /** Dispatch a message to every registered listener. */
  emit(msg: ExtensionToBotMessage): void {
    for (const cb of this.listeners.slice()) cb(msg);
  }
}

function makeFrameMsg(
  overrides: Partial<ExtensionAvatarFrameMessage> = {},
): ExtensionAvatarFrameMessage {
  return {
    type: "avatar.frame",
    bytes: overrides.bytes ?? "AAECAwQ=",
    width: overrides.width ?? 1280,
    height: overrides.height ?? 720,
    format: overrides.format ?? "y4m",
    ts: overrides.ts ?? 100,
  };
}

/** Minimal JPEG→Y4M spawn fake — returns a fixed payload. */
function makeTranscodeFactory(
  output: Uint8Array,
  opts: { failWith?: Error; delayMs?: number } = {},
): JpegToY4mSpawnFactory {
  return () => {
    let killed = false;
    return {
      readY4m: async () => {
        if (opts.delayMs) {
          await new Promise((r) => setTimeout(r, opts.delayMs));
        }
        if (killed) {
          throw new Error("killed");
        }
        if (opts.failWith) throw opts.failWith;
        return output;
      },
      exited: Promise.resolve(0),
      kill: () => {
        killed = true;
      },
    };
  };
}

describe("TalkingHeadRenderer", () => {
  afterEach(() => {
    // Registered once at module load; re-register after reset so
    // other tests that rely on resolveAvatarRenderer see the factory.
    // The import statement at the top of this file is idempotent — ES
    // modules cache imports — so we rely on that for the
    // `importRegistration` test below.
  });

  test("advertises id + capabilities", () => {
    const nativeMessaging = new FakeNativeMessaging();
    const r = new TalkingHeadRenderer({ nativeMessaging });
    expect(r.id).toBe(TALKING_HEAD_RENDERER_ID);
    expect(r.capabilities).toEqual({ needsVisemes: true, needsAudio: true });
  });

  test("constructor throws AvatarRendererUnavailableError when nativeMessaging is missing", () => {
    let err: unknown;
    try {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const _r = new TalkingHeadRenderer({});
    } catch (caught) {
      err = caught;
    }
    expect(err).toBeInstanceOf(AvatarRendererUnavailableError);
    const avatarErr = err as AvatarRendererUnavailableError;
    expect(avatarErr.rendererId).toBe(TALKING_HEAD_RENDERER_ID);
    expect(avatarErr.reason).toContain("native-messaging");
  });

  test("start() dispatches avatar.start and resolves on avatar.started ack", async () => {
    const nativeMessaging = new FakeNativeMessaging();
    const r = new TalkingHeadRenderer({
      nativeMessaging,
      startedAckTimeoutMs: 1_000,
      targetFps: 24,
    });
    const startPromise = r.start();

    // Exactly one avatar.start command must have been dispatched.
    expect(nativeMessaging.sent).toHaveLength(1);
    expect(nativeMessaging.sent[0]!.type).toBe("avatar.start");
    const startCmd = nativeMessaging.sent[0] as BotAvatarStartCommand;
    expect(startCmd.targetFps).toBe(24);

    // Simulate the extension's ack.
    const ack: ExtensionAvatarStartedMessage = { type: "avatar.started" };
    nativeMessaging.emit(ack);
    await startPromise;
  });

  test("start() forwards modelUrl when supplied", async () => {
    const nativeMessaging = new FakeNativeMessaging();
    const r = new TalkingHeadRenderer({
      nativeMessaging,
      startedAckTimeoutMs: 1_000,
      modelUrl: "chrome-extension://abcdef/avatar/custom.glb",
    });
    const startPromise = r.start();
    nativeMessaging.emit({ type: "avatar.started" });
    await startPromise;
    const startCmd = nativeMessaging.sent[0] as BotAvatarStartCommand;
    expect(startCmd.modelUrl).toBe(
      "chrome-extension://abcdef/avatar/custom.glb",
    );
  });

  test("start() throws AvatarRendererUnavailableError when the ack does not arrive in time", async () => {
    const nativeMessaging = new FakeNativeMessaging();
    const r = new TalkingHeadRenderer({
      nativeMessaging,
      startedAckTimeoutMs: 20,
    });
    let err: unknown;
    try {
      await r.start();
    } catch (caught) {
      err = caught;
    }
    expect(err).toBeInstanceOf(AvatarRendererUnavailableError);
    const avatarErr = err as AvatarRendererUnavailableError;
    expect(avatarErr.rendererId).toBe(TALKING_HEAD_RENDERER_ID);
    expect(avatarErr.reason).toContain("did not ack");
  });

  test("start() is a no-op on a second invocation against the same instance", async () => {
    const nativeMessaging = new FakeNativeMessaging();
    const r = new TalkingHeadRenderer({
      nativeMessaging,
      startedAckTimeoutMs: 500,
    });
    const startPromise = r.start();
    nativeMessaging.emit({ type: "avatar.started" });
    await startPromise;
    // Second call is a no-op — no additional avatar.start frame.
    await r.start();
    expect(
      nativeMessaging.sent.filter((m) => m.type === "avatar.start"),
    ).toHaveLength(1);
  });

  test("pushViseme forwards as avatar.push_viseme once the playback clock catches up", async () => {
    const nativeMessaging = new FakeNativeMessaging();
    const r = new TalkingHeadRenderer({
      nativeMessaging,
      startedAckTimeoutMs: 500,
    });
    const startPromise = r.start();
    nativeMessaging.emit({ type: "avatar.started" });
    await startPromise;

    // PR 9: visemes are held until the audio-playback clock catches
    // up to their declared timestamp. Advance the clock past both
    // visemes' timestamps so the buffer drains and the extension sees
    // both events in arrival order.
    r.pushViseme({ phoneme: "ah", weight: 0.8, timestamp: 500 });
    r.pushViseme({ phoneme: "ee", weight: 0.4, timestamp: 550 });
    r.notifyPlaybackTimestamp(550);

    const pushed = nativeMessaging.sent.filter(
      (m) => m.type === "avatar.push_viseme",
    ) as BotAvatarPushVisemeCommand[];
    expect(pushed).toHaveLength(2);
    expect(pushed[0]).toEqual({
      type: "avatar.push_viseme",
      phoneme: "ah",
      weight: 0.8,
      timestamp: 500,
    });
    expect(pushed[1]).toEqual({
      type: "avatar.push_viseme",
      phoneme: "ee",
      weight: 0.4,
      timestamp: 550,
    });
  });

  test("pushViseme is a no-op before start() and after stop()", async () => {
    const nativeMessaging = new FakeNativeMessaging();
    const r = new TalkingHeadRenderer({
      nativeMessaging,
      startedAckTimeoutMs: 500,
    });
    // Before start: no channel, no dispatch.
    r.pushViseme({ phoneme: "ah", weight: 0.5, timestamp: 10 });
    expect(nativeMessaging.sent).toHaveLength(0);

    const startPromise = r.start();
    nativeMessaging.emit({ type: "avatar.started" });
    await startPromise;
    await r.stop();

    // After stop: channel disposed, no dispatch.
    const before = nativeMessaging.sent.length;
    r.pushViseme({ phoneme: "ee", weight: 0.5, timestamp: 20 });
    expect(nativeMessaging.sent.length).toBe(before);
  });

  test("inbound avatar.frame (y4m) re-emits via onFrame", async () => {
    const nativeMessaging = new FakeNativeMessaging();
    const r = new TalkingHeadRenderer({
      nativeMessaging,
      startedAckTimeoutMs: 500,
    });
    const received: Y4MFrame[] = [];
    r.onFrame((f) => received.push(f));

    const startPromise = r.start();
    nativeMessaging.emit({ type: "avatar.started" });
    await startPromise;

    // `AAECAwQ=` decodes to [0,1,2,3,4].
    nativeMessaging.emit(
      makeFrameMsg({
        bytes: "AAECAwQ=",
        format: "y4m",
        width: 640,
        height: 480,
        ts: 1234,
      }),
    );

    // Bot needs a turn to process the async handler chain.
    await new Promise((r) => setTimeout(r, 5));

    expect(received).toHaveLength(1);
    expect(received[0]!.width).toBe(640);
    expect(received[0]!.height).toBe(480);
    expect(received[0]!.timestamp).toBe(1234);
    expect(Array.from(received[0]!.bytes)).toEqual([0, 1, 2, 3, 4]);
  });

  test("inbound avatar.frame (jpeg) transcodes via the injected ffmpeg factory and re-emits via onFrame", async () => {
    const nativeMessaging = new FakeNativeMessaging();
    const y4mPayload = new Uint8Array([0xaa, 0xbb, 0xcc]);
    const spawnJpegToY4m = makeTranscodeFactory(y4mPayload);
    const r = new TalkingHeadRenderer({
      nativeMessaging,
      startedAckTimeoutMs: 500,
      spawnJpegToY4m,
    });
    const received: Y4MFrame[] = [];
    r.onFrame((f) => received.push(f));

    const startPromise = r.start();
    nativeMessaging.emit({ type: "avatar.started" });
    await startPromise;

    nativeMessaging.emit(
      makeFrameMsg({
        bytes: "aGVsbG8=",
        format: "jpeg",
        width: 320,
        height: 240,
        ts: 42,
      }),
    );

    await new Promise((r) => setTimeout(r, 10));

    expect(received).toHaveLength(1);
    expect(Array.from(received[0]!.bytes)).toEqual([0xaa, 0xbb, 0xcc]);
    expect(received[0]!.width).toBe(320);
    expect(received[0]!.height).toBe(240);
  });

  test("onFrame returns a working unsubscribe", async () => {
    const nativeMessaging = new FakeNativeMessaging();
    const r = new TalkingHeadRenderer({
      nativeMessaging,
      startedAckTimeoutMs: 500,
    });
    const received: Y4MFrame[] = [];
    const unsubscribe = r.onFrame((f) => received.push(f));

    const startPromise = r.start();
    nativeMessaging.emit({ type: "avatar.started" });
    await startPromise;

    nativeMessaging.emit(makeFrameMsg({ bytes: "AA==", format: "y4m" }));
    await new Promise((r) => setTimeout(r, 5));
    expect(received).toHaveLength(1);

    unsubscribe();

    nativeMessaging.emit(makeFrameMsg({ bytes: "Ag==", format: "y4m" }));
    await new Promise((r) => setTimeout(r, 5));
    expect(received).toHaveLength(1);
  });

  test("failed jpeg transcode drops the frame without throwing", async () => {
    const nativeMessaging = new FakeNativeMessaging();
    const spawnJpegToY4m = makeTranscodeFactory(new Uint8Array(), {
      failWith: new Error("ffmpeg barfed"),
    });
    const r = new TalkingHeadRenderer({
      nativeMessaging,
      startedAckTimeoutMs: 500,
      spawnJpegToY4m,
    });
    const received: Y4MFrame[] = [];
    r.onFrame((f) => received.push(f));

    const startPromise = r.start();
    nativeMessaging.emit({ type: "avatar.started" });
    await startPromise;

    nativeMessaging.emit(makeFrameMsg({ bytes: "AA==", format: "jpeg" }));
    await new Promise((r) => setTimeout(r, 10));
    expect(received).toHaveLength(0);
  });

  test("stop() dispatches avatar.stop and disposes the channel", async () => {
    const nativeMessaging = new FakeNativeMessaging();
    const r = new TalkingHeadRenderer({
      nativeMessaging,
      startedAckTimeoutMs: 500,
    });
    const startPromise = r.start();
    nativeMessaging.emit({ type: "avatar.started" });
    await startPromise;

    await r.stop();
    const stopMsgs = nativeMessaging.sent.filter(
      (m) => m.type === "avatar.stop",
    );
    expect(stopMsgs).toHaveLength(1);
  });

  test("stop() is idempotent", async () => {
    const nativeMessaging = new FakeNativeMessaging();
    const r = new TalkingHeadRenderer({
      nativeMessaging,
      startedAckTimeoutMs: 500,
    });
    const startPromise = r.start();
    nativeMessaging.emit({ type: "avatar.started" });
    await startPromise;

    await r.stop();
    await r.stop();
    await r.stop();
    const stopMsgs = nativeMessaging.sent.filter(
      (m) => m.type === "avatar.stop",
    );
    // Second + third stop() are no-ops.
    expect(stopMsgs).toHaveLength(1);
  });

  test("stop() rejects a pending start() waiter", async () => {
    const nativeMessaging = new FakeNativeMessaging();
    const r = new TalkingHeadRenderer({
      nativeMessaging,
      startedAckTimeoutMs: 5_000,
    });
    const startPromise = r.start();
    // Do not emit the ack; instead, call stop() to race the waiter.
    void r.stop();

    let err: unknown;
    try {
      await startPromise;
    } catch (caught) {
      err = caught;
    }
    expect(err).toBeInstanceOf(AvatarRendererUnavailableError);
    expect((err as AvatarRendererUnavailableError).reason).toContain(
      "stopped before",
    );
  });

  test("frames arriving after stop() are dropped at the channel layer", async () => {
    const nativeMessaging = new FakeNativeMessaging();
    const r = new TalkingHeadRenderer({
      nativeMessaging,
      startedAckTimeoutMs: 500,
    });
    const received: Y4MFrame[] = [];
    r.onFrame((f) => received.push(f));

    const startPromise = r.start();
    nativeMessaging.emit({ type: "avatar.started" });
    await startPromise;
    await r.stop();

    nativeMessaging.emit(makeFrameMsg({ bytes: "AA==", format: "y4m" }));
    await new Promise((r) => setTimeout(r, 5));
    expect(received).toHaveLength(0);
  });
});

describe("TalkingHead factory registration", () => {
  beforeEach(() => {
    // Sibling test suites (e.g. avatar-registry.test.ts) may have
    // called __resetAvatarRegistryForTests() before we arrive. Re-
    // register the factory so our assertions against the registry
    // work no matter which order tests run in.
    ensureTalkingHeadRegistered();
  });

  test("the talking-head factory is registered with the registry", () => {
    expect(isAvatarRendererRegistered(TALKING_HEAD_RENDERER_ID)).toBe(true);
  });

  test("factory throws AvatarRendererUnavailableError when deps.nativeMessaging is missing", () => {
    let err: unknown;
    try {
      resolveAvatarRenderer(
        { enabled: true, renderer: TALKING_HEAD_RENDERER_ID },
        {},
      );
    } catch (caught) {
      err = caught;
    }
    expect(err).toBeInstanceOf(AvatarRendererUnavailableError);
    expect((err as AvatarRendererUnavailableError).rendererId).toBe(
      TALKING_HEAD_RENDERER_ID,
    );
  });

  test("factory returns a working renderer when deps.nativeMessaging is wired", () => {
    const nativeMessaging = new FakeNativeMessaging();
    const renderer = resolveAvatarRenderer(
      { enabled: true, renderer: TALKING_HEAD_RENDERER_ID },
      { nativeMessaging },
    );
    expect(renderer).not.toBeNull();
    expect(renderer!.id).toBe(TALKING_HEAD_RENDERER_ID);
    expect(renderer!.capabilities).toEqual({
      needsVisemes: true,
      needsAudio: true,
    });
  });

  test("factory reads optional talkingHead sub-config", () => {
    const nativeMessaging = new FakeNativeMessaging();
    const renderer = resolveAvatarRenderer(
      {
        enabled: true,
        renderer: TALKING_HEAD_RENDERER_ID,
        talkingHead: {
          modelUrl: "chrome-extension://abc/avatar/custom.glb",
          targetFps: 30,
          startedAckTimeoutMs: 2000,
        },
      },
      { nativeMessaging },
    );
    expect(renderer).not.toBeNull();
    expect(renderer!.id).toBe(TALKING_HEAD_RENDERER_ID);
  });

  test("a registry reset clears the talking-head factory", () => {
    // Sanity check: the reset helper works as documented. Sibling
    // tests (avatar-registry.test.ts) rely on this invariant to
    // scope their own factory registrations to the test scope.
    __resetAvatarRegistryForTests();
    expect(isAvatarRendererRegistered(TALKING_HEAD_RENDERER_ID)).toBe(false);
  });
});
