/**
 * Public entry point for the meet-bot's avatar subsystem.
 *
 * Re-exports the shared interface types, the renderer registry, the
 * device writer, and the noop renderer. Importing the barrel pulls in
 * the noop renderer's import-time self-registration so
 * `resolveAvatarRenderer({ renderer: "noop" })` just works. Concrete
 * backend renderers (TalkingHead.js, hosted WebRTC, GPU sidecars) land
 * in the PR 5a/b/c/d follow-ups — those PRs import their own file
 * (e.g. `./backends/simli-renderer.js`) for the same side-effect
 * registration pattern.
 */
export {
  AvatarRendererUnavailableError,
  type AvatarCapabilities,
  type AvatarRenderer,
  type VisemeEvent,
  type Y4MFrame,
} from "./types.js";

export {
  attachDeviceWriter,
  DEFAULT_MAX_FPS,
  type AttachDeviceWriterOptions,
  type DeviceWriterHandle,
  type DeviceWriterSink,
} from "./device-writer.js";

export { NoopAvatarRenderer } from "./noop-renderer.js";

export {
  __resetAvatarRegistryForTests,
  isAvatarRendererRegistered,
  listRegisteredAvatarRenderers,
  registerAvatarRenderer,
  resolveAvatarRenderer,
  type AvatarConfig,
  type AvatarNativeMessagingSender,
  type AvatarRendererDeps,
  type AvatarRendererFactory,
} from "./registry.js";

// Side-effect import: registers the noop factory under `"noop"` so
// `resolveAvatarRenderer` can find it when something explicitly asks
// for the id rather than relying on the null short-circuit path.
import "./noop-renderer.js";

// Side-effect import: registers the TalkingHead.js factory under
// `"talking-head"`. The factory throws AvatarRendererUnavailableError
// when `deps.nativeMessaging` isn't wired (e.g. in tests without a
// socket server) so the HTTP layer turns that into a 503 with a
// clear reason rather than crashing.
import "./talking-head/index.js";
