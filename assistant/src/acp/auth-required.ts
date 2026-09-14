/**
 * Detection of Claude authentication failures on ACP runs.
 *
 * These failures reach the daemon in two shapes, and both are needed:
 *
 * 1. No credentials at all: the adapter raises a structured ACP
 *    `auth_required` rejection (JSON-RPC -32000). {@link isAcpAuthRequired}.
 * 2. Credentials present but rejected (the expired/revoked case): the CLI
 *    surfaces the API 401 as an error message it authors, and the adapter
 *    relays it as a generic -32603 internal error, NOT as `auth_required`.
 *    {@link isClaudeAuthFailureMessage}, over the text
 *    {@link requestErrorReason} decodes out of the rejection.
 *
 * A positive detection becomes {@link ACP_CLAUDE_AUTH_REQUIRED_CODE} on the
 * `acp_auth_required` event, which the client turns into the inline
 * "Connect Claude Code" card.
 */

export { ACP_CLAUDE_AUTH_REQUIRED_CODE } from "../api/events/acp-auth-required.js";

/**
 * JSON-RPC error code agents use to signal that authentication is required
 * (matches the ACP SDK's `RequestError.authRequired()`).
 */
export const AUTH_REQUIRED_CODE = -32000;

/**
 * An agent rejected an operation with `auth_required` and the daemon has no
 * way to satisfy it. A distinct type so the classification survives to the
 * session manager, where the failure becomes an event the UI can act on.
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
 * Detects the structured auth-required signal in either shape it travels: the
 * raw JSON-RPC rejection from the agent, or our own
 * {@link AcpAuthRequiredError}. Checks the `code` property rather than an
 * `instanceof` so plain JSON-RPC error objects are recognized too.
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
 * The Claude CLI's own auth-failure phrasings. Unanchored (no ^/$) because
 * the messages arrive with adapter framing ("Internal error: ...") or as a
 * line `deriveFailureError` picked out of stderr.
 */
const CLAUDE_AUTH_FAILURE_PATTERNS: readonly RegExp[] = [
  /Failed to authenticate\b/,
  /Please run \/login/,
  /\bNot logged in\b/,
];

/**
 * Whether a failure message is a Claude authentication failure. Callers gate
 * on the adapter (`claude-agent-acp`) BEFORE consulting this: the patterns
 * are Claude-specific, and the marker built on them promises a repair only
 * the Connect Claude flow can perform.
 */
export function isClaudeAuthFailureMessage(
  message: string | undefined,
): boolean {
  return (
    message != null &&
    CLAUDE_AUTH_FAILURE_PATTERNS.some((pattern) => pattern.test(message))
  );
}

/** Messages the SDK's `RequestError` factories build when given no text. */
const GENERIC_RPC_MESSAGES: ReadonlySet<string> = new Set([
  "Parse error",
  "Invalid request",
  "Invalid params",
  "Internal error",
  "Request cancelled",
  "Authentication required",
  "Resource not found",
]);

/**
 * The sentence behind a JSON-RPC rejection. An adapter that throws a plain
 * Error reaches the client as a bare "Internal error" whose real text the
 * agent-side SDK moved into `data.details`. An adapter that raises
 * `RequestError.internalError(data, text)` keeps its words in the message and
 * only supplemental context in `data`, so a specific message wins. Behind a
 * generic message such as "Invalid params", `data.details` or the serialized
 * payload supplies the reason instead. Duck-typed like
 * {@link isAcpAuthRequired}:
 * `message` is read as a property, so a rejection that arrives as a plain
 * object off the wire decodes the same as an `Error` instance.
 */
export function requestErrorReason(err: unknown): string {
  if (typeof err !== "object" || err === null) {
    return String(err);
  }
  const { data, message } = err as { data?: unknown; message?: unknown };
  const own = typeof message === "string" ? message : String(err);
  if (data == null) {
    return own;
  }
  if (
    typeof message === "string" &&
    message.length > 0 &&
    !GENERIC_RPC_MESSAGES.has(message)
  ) {
    return message;
  }
  const details = (data as { details?: unknown }).details;
  if (typeof details === "string" && details.length > 0) {
    return details;
  }
  // JSON.stringify answers undefined for a value it cannot represent.
  const serialized: string | undefined = JSON.stringify(data);
  return serialized ?? own;
}

/** The adapter whose auth failures the Connect Claude flow can repair. */
export const CLAUDE_ACP_COMMAND = "claude-agent-acp";

/**
 * Model-facing text accompanying a Claude auth failure wherever the inline
 * Connect card is raised (the tool result for a pre-spawn rejection, the
 * parent notification for a post-spawn one), so the model points at the card
 * instead of inventing a remedy (CLI commands, pasted tokens, or a card that
 * is not there). Bans placement words because card position is a UI detail
 * the model cannot see.
 */
export const ACP_AUTH_RECOVERY_GUIDANCE =
  "The Claude Code connection needs to be re-authorized. The app shows the " +
  'user an inline "Connect Claude Code" card. Reply with ONE short sentence: ' +
  "ask them to click Connect to sign in again, and tell them you'll continue " +
  "automatically once they are connected. Do NOT say where the card is; never " +
  'say "below", "above", "at the bottom", or "here". Do NOT tell them to run ' +
  "`claude setup-token`, paste a token in chat, run credential CLI commands, " +
  "or re-run the agent yourself; the card and auto-continue handle it.";
