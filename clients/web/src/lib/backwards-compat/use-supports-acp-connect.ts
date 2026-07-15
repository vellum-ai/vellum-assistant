/**
 * Backwards-compat gate: the in-app "Connect Claude Code" OAuth flow for ACP.
 *
 * The Connect surfaces (the inline chat affordance on a missing-token
 * `acp_spawn`, and the Settings → Models & Services section) drive daemon routes
 * — `/v1/acp/claude/auth/{start,exchange,status,connected}` — that did not exist
 * before 0.10.10. The web app always serves the latest bundle, but the assistant
 * can be any locally-installed version, so showing Connect against an older
 * daemon would surface a button that 404s. Gate the UI on the daemon being new
 * enough to serve the routes; on the `false` branch the surfaces render nothing
 * (a missing-token spawn keeps its plain error rendering).
 *
 * This replaces the retired `acp-claude-oauth-connect` feature flag: that flag
 * existed mainly as a ToS kill switch for the cloud/off-device path, which has
 * since been cleared, leaving daemon-version compatibility as the only gate the
 * feature still needs.
 *
 * MIN_VERSION targets 0.10.10 — the release that ships the Connect Claude auth
 * routes.
 */
import { useAssistantSupports } from "./utils";

export const MIN_VERSION = "0.10.10";

/** Returns `true` when the active assistant is new enough to serve the Connect
 *  Claude auth routes. Conservative (`false`) until the version hydrates. */
export function useSupportsAcpConnect(): boolean {
  return useAssistantSupports(MIN_VERSION);
}
