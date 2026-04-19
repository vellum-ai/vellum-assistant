/**
 * Public entry point for the meet-bot's avatar subsystem.
 *
 * Only the shared types/interface are re-exported today. Concrete
 * renderers (TalkingHead.js, hosted WebRTC, GPU sidecars) and the
 * renderer factory land in PR 5 and the PR 5a/b/c/d follow-ups.
 */
export {
  AvatarRendererUnavailableError,
  type AvatarCapabilities,
  type AvatarRenderer,
  type VisemeEvent,
  type Y4MFrame,
} from "./types.js";
