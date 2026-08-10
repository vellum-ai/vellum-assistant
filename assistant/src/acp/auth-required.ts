/**
 * The ACP auth-required signal, and the marker that carries it to the client.
 *
 * When a Claude Code turn fails authentication, the CLI injects a synthetic
 * "Please run /login" assistant message. `claude-agent-acp` deliberately does
 * NOT pass that TUI-specific text through: it converts it into a structured ACP
 * `auth_required` rejection so the client can run its own auth flow. That
 * rejection is the one trustworthy, adapter-agnostic statement that a run died
 * because its credential is no longer good, and it is what the inline
 * re-authentication affordance is built on.
 *
 * Keeping the signal STRUCTURED matters. The human-readable text around it is
 * not stable enough to key on: it varies by adapter and by failure mode, and
 * `deriveFailureError` may replace it wholesale with whatever the adapter last
 * wrote to stderr (for an expired Claude token, the provider's raw
 * "401 OAuth access token has expired"). Matching on that string would be
 * guessing at a moving target when the protocol already told us the answer.
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
