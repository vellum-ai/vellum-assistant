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

/**
 * Marker for a token that EXISTS but was rejected by the agent, carried on
 * the `acp_auth_required` event. A POST-spawn failure: the spawn succeeded,
 * so there is no failed tool call for the missing-token machinery to key on;
 * the affordance anchors to the run's spawning tool call instead.
 */
export { ACP_CLAUDE_AUTH_REQUIRED_CODE } from "@vellumai/assistant-api";

/**
 * Hidden continuation prompt sent on the user's behalf once the inline Connect
 * card completes, so the assistant picks the task back up without the user
 * having to type "retry". Delivered as a `hidden` send (no user bubble); the
 * model reads it and re-invokes `acp_spawn`, which now finds a valid stored
 * token. Shared by both card reasons: a token that was never stored and a
 * stored token the agent rejected.
 */
export const ACP_CONNECT_CONTINUE_PROMPT =
  "Claude Code is now connected. Continue with the task I asked for: " +
  "re-run the Claude Code spawn that failed for lack of a valid token.";
