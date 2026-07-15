/**
 * Shared marker for the "Connect Claude Code" ACP affordance.
 *
 * When an `acp_spawn` fails because the `claude-agent-acp` OAuth token is
 * missing, the daemon tags the live `tool_result` with this `errorCode` (see
 * `ACP_CLAUDE_OAUTH_MISSING_CODE` in `assistant/src/acp/prepare-agent-env.ts`).
 * The stream handler promotes that live signal into the interaction store so
 * the inline Connect affordance survives the routine `/messages` reseed —
 * which strips the reseed-able tool-call `errorCode` field — instead of
 * vanishing mid-turn. The web literal and the daemon literal are a wire
 * contract and must stay in sync.
 */
export const ACP_CLAUDE_OAUTH_MISSING_CODE = "acp_claude_oauth_missing";
