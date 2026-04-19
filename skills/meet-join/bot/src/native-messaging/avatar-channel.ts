/**
 * Bot-side helpers for the `avatar.*` family of native-messaging
 * messages. These helpers wrap the {@link NmhSocketServer}'s
 * `sendToExtension` + `onExtensionMessage` APIs with typed convenience
 * functions so the TalkingHead.js renderer's implementation doesn't
 * have to repeat the envelope shapes inline.
 *
 * The channel is intentionally thin — it is not a full state machine.
 * Its only jobs are:
 *
 * 1. Emit `avatar.start` / `avatar.stop` / `avatar.push_viseme` to the
 *    extension, wrapped in the discriminated-union types the
 *    contracts package defines.
 * 2. Dispatch inbound `avatar.started` and `avatar.frame` messages
 *    from the extension to caller-provided handlers, ignoring all
 *    other frames (which belong to the bot's main message router).
 *
 * Keeping this in its own module means the TalkingHead renderer can
 * depend on a narrow, typed interface and swap a fake in for unit
 * tests (see {@link AvatarChannel}).
 */

import type {
  BotAvatarPushVisemeCommand,
  BotAvatarStartCommand,
  BotAvatarStopCommand,
  ExtensionAvatarFrameMessage,
  ExtensionAvatarStartedMessage,
  ExtensionToBotMessage,
} from "../../../contracts/native-messaging.js";

/**
 * Narrow slice of the inbound-message routing hook the channel needs.
 * Mirrors {@link NmhSocketServer.onExtensionMessage} but accepts only
 * the messages the avatar channel cares about — the TalkingHead
 * renderer passes through the full socket-server callback via
 * {@link createAvatarChannel}.
 */
export interface AvatarChannelInboundHandlers {
  /**
   * Invoked exactly once per `avatar.started` ack. Used by the renderer
   * to complete its `start()` promise (bounded by a 5 s timeout at the
   * renderer layer).
   */
  onStarted: (msg: ExtensionAvatarStartedMessage) => void;
  /**
   * Invoked for every `avatar.frame` the extension forwards. The
   * renderer decodes base64 bytes and re-emits through `onFrame`
   * subscribers.
   */
  onFrame: (msg: ExtensionAvatarFrameMessage) => void;
}

/**
 * Narrow slice of the outbound-send hook the channel needs. Mirrors
 * {@link NmhSocketServer.sendToExtension} but typed to the bot→extension
 * union so mis-typed payloads surface at compile time rather than on
 * the wire.
 */
export interface AvatarChannelSender {
  sendToExtension: (
    msg:
      | BotAvatarStartCommand
      | BotAvatarStopCommand
      | BotAvatarPushVisemeCommand,
  ) => void;
}

/**
 * Typed helper bundle the TalkingHead renderer uses to communicate
 * over the native-messaging bridge without repeating the envelope
 * shapes inline.
 */
export interface AvatarChannel {
  /** Send `avatar.start` to the extension. */
  start(opts?: { targetFps?: number; modelUrl?: string }): void;
  /** Send `avatar.stop` to the extension. Idempotent at the wire level. */
  stop(): void;
  /** Send `avatar.push_viseme` to the extension. */
  pushViseme(event: {
    phoneme: string;
    weight: number;
    timestamp: number;
  }): void;
  /**
   * Detach the inbound listener. Idempotent. Callers call this in
   * the renderer's `stop()` path so a late `avatar.frame` arriving
   * after teardown is dropped at the channel level instead of
   * bubbling into a subscriber that no longer exists.
   */
  dispose(): void;
}

export interface CreateAvatarChannelOptions {
  /**
   * Outbound transport. In production this is the `NmhSocketServer`
   * created in `main.ts`; tests pass a fake that records sent
   * messages.
   */
  sender: AvatarChannelSender;
  /**
   * Called to register the inbound listener. The channel returns a
   * wrapper that filters on `avatar.started` / `avatar.frame` and
   * invokes the matching handler; all other message types are ignored
   * (they are handled by the bot's main message router).
   *
   * The callback signature matches {@link NmhSocketServer.onExtensionMessage}
   * so the channel can plug straight into the existing socket server
   * without additional adaptation.
   */
  onExtensionMessage: (cb: (msg: ExtensionToBotMessage) => void) => void;
  /** Handler set for the inbound messages the channel cares about. */
  handlers: AvatarChannelInboundHandlers;
}

/**
 * Build a typed channel that wraps the provided sender + inbound hook.
 *
 * The channel registers a single inbound listener at construction time
 * and routes `avatar.started` / `avatar.frame` to the matching
 * handler. Unknown message types are ignored (they belong to the
 * bot's main message router and the channel is not a sole consumer).
 *
 * Because `NmhSocketServer.onExtensionMessage` appends listeners
 * without a way to unregister, {@link AvatarChannel.dispose} sets an
 * internal `disposed` flag that short-circuits the filter — a late
 * frame arriving after teardown is dropped at the channel layer
 * without touching the renderer.
 */
export function createAvatarChannel(
  opts: CreateAvatarChannelOptions,
): AvatarChannel {
  let disposed = false;

  opts.onExtensionMessage((msg) => {
    if (disposed) return;
    if (msg.type === "avatar.started") {
      opts.handlers.onStarted(msg);
      return;
    }
    if (msg.type === "avatar.frame") {
      opts.handlers.onFrame(msg);
      return;
    }
    // Any other message type is ignored at the channel level — the
    // bot's main message router handles it.
  });

  return {
    start(startOpts = {}): void {
      if (disposed) return;
      const msg: BotAvatarStartCommand = {
        type: "avatar.start",
        ...(startOpts.targetFps !== undefined
          ? { targetFps: startOpts.targetFps }
          : {}),
        ...(startOpts.modelUrl !== undefined
          ? { modelUrl: startOpts.modelUrl }
          : {}),
      };
      opts.sender.sendToExtension(msg);
    },
    stop(): void {
      if (disposed) return;
      const msg: BotAvatarStopCommand = { type: "avatar.stop" };
      opts.sender.sendToExtension(msg);
    },
    pushViseme(event): void {
      if (disposed) return;
      const msg: BotAvatarPushVisemeCommand = {
        type: "avatar.push_viseme",
        phoneme: event.phoneme,
        weight: event.weight,
        timestamp: event.timestamp,
      };
      opts.sender.sendToExtension(msg);
    },
    dispose(): void {
      disposed = true;
    },
  };
}
