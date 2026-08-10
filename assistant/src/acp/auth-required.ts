/**
 * Detection of Claude authentication failures on ACP runs, and the marker that
 * carries the classification to the client.
 *
 * Claude auth failures reach the daemon in TWO distinct shapes, and both are
 * needed. Verified against `claude-agent-acp` 0.63.0 / Claude Code CLI 2.1.220
 * by live probe, since the shapes are decided across a compiled binary and a
 * server response:
 *
 * 1. NO credentials at all: the CLI injects a synthetic "Please run /login"
 *    assistant message, which the adapter converts into a structured ACP
 *    `auth_required` rejection (JSON-RPC -32000) so the client can run its own
 *    auth flow. {@link isAcpAuthRequired} catches this shape.
 * 2. Credentials PRESENT but rejected (the expired/revoked-token case, and the
 *    one users actually hit): the CLI surfaces the API's 401 as an error whose
 *    message it authors, e.g. "Failed to authenticate. API Error: 401 OAuth
 *    access token has been revoked." The adapter relays it as a generic
 *    JSON-RPC -32603 internal error, NOT as `auth_required`.
 *    {@link isClaudeAuthFailureMessage} catches this shape.
 *
 * The second matcher is text-based by necessity, but it is anchored: the
 * Claude Code binary ships `^Failed to authenticate\.`, `^Please run \/login ·`
 * and `^Not logged in$` as its own classification constants, so these patterns
 * mirror the CLI's contract with itself. They match CLI-authored framing, never
 * the server's variable suffixes ("has expired" vs "has been revoked").
 */

/**
 * JSON-RPC error code agents use to signal that authentication is required
 * (matches the SDK's `RequestError.authRequired()`).
 */
export const AUTH_REQUIRED_CODE = -32000;

/**
 * Raised when an agent rejected an operation with `auth_required` and the
 * daemon has no way to satisfy it on the user's behalf.
 *
 * A distinct type rather than a plain `Error` so the classification survives
 * the trip to the session manager, which is where the failure becomes an event
 * the UI can act on. Thrown as a plain `Error`, the fact that this was an
 * AUTH failure (rather than a crash, a timeout, or a bad prompt) was
 * unrecoverable by the time anything could offer the user a fix.
 */
export class AcpAuthRequiredError extends Error {
  constructor(
    readonly agentId: string,
    message: string,
  ) {
    super(message);
    this.name = "AcpAuthRequiredError";
  }
}

/**
 * Detects the ACP auth-required signal in either shape it reaches us: the raw
 * JSON-RPC rejection from the agent, or our own {@link AcpAuthRequiredError}
 * after the retry path gave up. Checks the `code` property rather than
 * `instanceof acp.RequestError` so plain JSON-RPC error objects are also
 * recognized.
 */
export function isAcpAuthRequired(err: unknown): boolean {
  if (err instanceof AcpAuthRequiredError) {
    return true;
  }
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === AUTH_REQUIRED_CODE
  );
}

/**
 * The CLI-authored auth-failure phrasings, mirrored from the constants the
 * Claude Code binary uses for its own error classification. Deliberately
 * unanchored (no ^/$): by the time these messages reach the session manager
 * they carry adapter framing ("Internal error: Failed to authenticate. ..."),
 * and `deriveFailureError` may have picked the line out of stderr instead.
 */
const CLAUDE_AUTH_FAILURE_PATTERNS: readonly RegExp[] = [
  /Failed to authenticate\b/,
  /Please run \/login/,
  /\bNot logged in\b/,
];

/**
 * Whether a failure message is a Claude authentication failure, per the CLI's
 * own phrasings. Callers gate on the adapter (`claude-agent-acp`) BEFORE
 * consulting this: the patterns are Claude-specific, and the marker built on
 * them promises a repair only the Connect Claude flow can perform.
 */
export function isClaudeAuthFailureMessage(
  message: string | undefined,
): boolean {
  return (
    message != null &&
    CLAUDE_AUTH_FAILURE_PATTERNS.some((pattern) => pattern.test(message))
  );
}

/**
 * Stable, machine-readable marker carried on `acp_session_error` when a
 * `claude-agent-acp` run failed because its Claude credential needs to be
 * reconnected. Lets the client offer the same inline "Connect Claude Code"
 * affordance the missing-token path raises, instead of rendering dead error
 * text. Kept in lockstep with the web literal in
 * `clients/web/src/domains/chat/utils/acp-connect.ts`.
 *
 * Sibling of `ACP_CLAUDE_OAUTH_MISSING_CODE`, which covers the case where no
 * token was ever stored. This one covers a token that exists but is no longer
 * accepted, which is a POST-spawn failure and so cannot ride on the
 * `acp_spawn` tool result the way the missing-token marker does.
 */
export const ACP_CLAUDE_AUTH_REQUIRED_CODE = "acp_claude_auth_required";

/** The adapter whose auth failures the Connect Claude flow can repair. */
export const CLAUDE_ACP_COMMAND = "claude-agent-acp";
