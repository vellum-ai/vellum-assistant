/**
 * TalkingHead.js renderer barrel + import-time self-registration.
 *
 * Importing this module registers the `"talking-head"` factory with
 * the avatar registry. The bot's `main.ts` pulls this file in at
 * boot so `resolveAvatarRenderer({ renderer: "talking-head" })` can
 * find the factory by id.
 *
 * The factory reads the native-messaging sender from the
 * {@link AvatarRendererDeps} bag. If the sender is absent (because the
 * bot was booted without a live NMH socket server, e.g. a smoke test)
 * the renderer constructor throws
 * {@link AvatarRendererUnavailableError} — the registry lets that
 * propagate so the HTTP layer turns it into a 503 with a clear
 * reason.
 *
 * Per-renderer configuration lives under
 * `services.meet.avatar.talkingHead` on the daemon side. The factory
 * extracts:
 *
 * - `modelPath` / `modelUrl` — optional override for the bundled GLB.
 * - `targetFps` — optional advisory hint forwarded to the extension.
 * - `startedAckTimeoutMs` — optional override for the bounded wait
 *   on the `avatar.started` ack.
 *
 * None of these are required; all have sensible defaults.
 */

import {
  registerAvatarRenderer,
  type AvatarConfig,
  type AvatarRendererDeps,
} from "../registry.js";
import { AvatarRendererUnavailableError } from "../types.js";

import {
  TalkingHeadRenderer,
  TALKING_HEAD_RENDERER_ID,
  type TalkingHeadRendererOptions,
} from "./renderer.js";

export {
  TalkingHeadRenderer,
  TALKING_HEAD_RENDERER_ID,
  DEFAULT_STARTED_ACK_TIMEOUT_MS,
  DEFAULT_TARGET_FPS,
  TALKING_HEAD_CAPABILITIES,
  type JpegToY4mSpawnFactory,
  type TalkingHeadRendererOptions,
} from "./renderer.js";

/**
 * Narrow cast for the `services.meet.avatar.talkingHead` sub-object.
 * Permissive shape so the bot package doesn't have to import the
 * daemon's config schema — we validate each field we read.
 */
function readTalkingHeadSubConfig(
  config: AvatarConfig,
): Partial<{ modelUrl: string; targetFps: number; startedAckTimeoutMs: number }> {
  const raw = (config as Record<string, unknown>).talkingHead;
  if (!raw || typeof raw !== "object") return {};
  const sub = raw as Record<string, unknown>;
  const out: Partial<{
    modelUrl: string;
    targetFps: number;
    startedAckTimeoutMs: number;
  }> = {};
  // Accept either `modelUrl` (preferred, explicit extension-URL) or
  // `modelPath` (operator-facing: an absolute filesystem path the bot
  // can turn into a file URL at a later stage).
  const modelUrl = typeof sub.modelUrl === "string" ? sub.modelUrl : undefined;
  const modelPath =
    typeof sub.modelPath === "string" && sub.modelPath.length > 0
      ? sub.modelPath
      : undefined;
  if (modelUrl) out.modelUrl = modelUrl;
  else if (modelPath) out.modelUrl = modelPath;
  if (typeof sub.targetFps === "number" && Number.isInteger(sub.targetFps)) {
    out.targetFps = sub.targetFps;
  }
  if (
    typeof sub.startedAckTimeoutMs === "number" &&
    sub.startedAckTimeoutMs > 0
  ) {
    out.startedAckTimeoutMs = sub.startedAckTimeoutMs;
  }
  return out;
}

/**
 * Factory the registry invokes on `/avatar/enable`. Throws
 * {@link AvatarRendererUnavailableError} when the native-messaging
 * surface isn't wired — the session-manager catches that specifically
 * and falls back to the noop renderer.
 */
registerAvatarRenderer(TALKING_HEAD_RENDERER_ID, (config, deps) => {
  if (!deps.nativeMessaging) {
    throw new AvatarRendererUnavailableError(
      TALKING_HEAD_RENDERER_ID,
      "native-messaging surface not wired (bot was booted without an NMH socket server)",
    );
  }
  const sub = readTalkingHeadSubConfig(config);
  const opts: TalkingHeadRendererOptions = {
    nativeMessaging: deps.nativeMessaging,
    ...(sub.modelUrl !== undefined ? { modelUrl: sub.modelUrl } : {}),
    ...(sub.targetFps !== undefined ? { targetFps: sub.targetFps } : {}),
    ...(sub.startedAckTimeoutMs !== undefined
      ? { startedAckTimeoutMs: sub.startedAckTimeoutMs }
      : {}),
    ...(deps.logger ? { logger: deps.logger } : {}),
  };
  return new TalkingHeadRenderer(opts);
});

// Re-export nothing else; this module's sole side effect is the
// registration call above.
export {};
