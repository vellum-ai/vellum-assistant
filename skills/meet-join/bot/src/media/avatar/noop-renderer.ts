/**
 * Noop avatar renderer — the safe default / fallback backend.
 *
 * Used in two situations:
 *
 * 1. `services.meet.avatar.enabled = false` or
 *    `services.meet.avatar.renderer = "noop"`: the feature is explicitly
 *    off, so the registry short-circuits before even consulting this
 *    renderer. The bot never attaches a device writer and Meet sees no
 *    video track.
 *
 * 2. A concrete renderer fails to construct
 *    ({@link AvatarRendererUnavailableError}). The session-manager falls
 *    back to the noop renderer so `/avatar/enable` can still return 200
 *    and the meeting proceeds — the bot simply emits no frames instead
 *    of a broken video stream.
 *
 * The renderer advertises `{ needsVisemes: false, needsAudio: false }`
 * so the daemon can skip the TTS lip-sync forwarder and the PCM fan-out
 * when this backend is active. `pushAudio` / `pushViseme` remain
 * callable for interface conformance but drop every input; `onFrame`
 * never fires.
 *
 * Importing this module has the side effect of registering the factory
 * under the `"noop"` id so `resolveAvatarRenderer` can find it by name
 * if some caller explicitly asks for it. The bot's entry point imports
 * this file at boot so the registration lands before any HTTP traffic
 * can arrive.
 */

import { registerAvatarRenderer } from "./registry.js";
import type {
  AvatarCapabilities,
  AvatarRenderer,
  VisemeEvent,
  Y4MFrame,
} from "./types.js";

const NOOP_ID = "noop";
const NOOP_CAPS: AvatarCapabilities = {
  needsVisemes: false,
  needsAudio: false,
};

/**
 * The noop renderer itself. Everything is a no-op except bookkeeping:
 * `startCount` / `stopCount` are exposed for tests but not part of the
 * public {@link AvatarRenderer} surface — external callers must not
 * depend on these fields.
 */
export class NoopAvatarRenderer implements AvatarRenderer {
  readonly id = NOOP_ID;
  readonly capabilities = NOOP_CAPS;

  /** Incremented on each `start()` call. Tests only. */
  startCount = 0;
  /** Incremented on each `stop()` call. Tests only. */
  stopCount = 0;

  async start(): Promise<void> {
    this.startCount += 1;
  }

  async stop(): Promise<void> {
    this.stopCount += 1;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- interface contract
  pushAudio(_pcm: Uint8Array, _ts: number): void {
    // Intentionally empty — the renderer advertises `needsAudio: false`,
    // but the interface contract says this method is always callable.
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- interface contract
  pushViseme(_event: VisemeEvent): void {
    // Intentionally empty — see `pushAudio`.
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- interface contract
  onFrame(_cb: (frame: Y4MFrame) => void): () => void {
    // No frames will ever fire, but the contract requires a real
    // unsubscribe function. Return a no-op disposer so callers that
    // invoke it (idempotently) don't throw.
    return () => {
      /* noop */
    };
  }
}

// Register at import time so a later `resolveAvatarRenderer({ renderer: "noop" })`
// finds the factory. The registry's short-circuit for `"noop"` means this
// factory is rarely actually invoked — it exists so tests and explicit
// callers that bypass the short-circuit (e.g. a fallback path that
// synthesizes an AvatarConfig) still have something to resolve.
registerAvatarRenderer(NOOP_ID, () => new NoopAvatarRenderer());
