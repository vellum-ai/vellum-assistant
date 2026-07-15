import { isAssistantFeatureFlagEnabled } from "../config/assistant-feature-flags.js";
import type { AssistantConfig } from "../config/schema.js";

/** Feature-flag id (kebab-case) gating the in-app Connect Claude Code OAuth
 *  flow for ACP. Gates the connect UI; the cloud paste path is additionally
 *  host-gated. Default off so the whole feature ships dark. */
export const ACP_CLAUDE_OAUTH_CONNECT = "acp-claude-oauth-connect" as const;

export function isAcpClaudeOauthConnectEnabled(
  config: AssistantConfig,
): boolean {
  return isAssistantFeatureFlagEnabled(ACP_CLAUDE_OAUTH_CONNECT, config);
}
