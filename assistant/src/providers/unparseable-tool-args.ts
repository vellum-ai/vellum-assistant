/**
 * Marker shape for tool-call arguments that failed JSON parsing.
 *
 * Streaming providers accumulate tool-call argument deltas as a string and
 * parse the result once the stream completes. Some models/gateways emit
 * truncated or malformed argument JSON (e.g. MiniMax M3 via OpenRouter cutting
 * the stream mid-object). The provider cannot drop the tool_use block — the
 * protocol requires a paired tool_result for every tool_use id — so it wraps
 * the raw string under this marker key instead.
 *
 * The tool execution layer detects the marker and rejects the invocation with
 * an error tool result, so the model sees the failure and can retry, instead
 * of a tool executing with garbage input.
 */
const UNPARSEABLE_TOOL_ARGS_KEY = "_raw";

/** Wrap raw, unparseable tool-call argument text in the marker shape. */
export function wrapUnparseableToolArgs(raw: string): Record<string, unknown> {
  return { [UNPARSEABLE_TOOL_ARGS_KEY]: raw };
}

/**
 * Detect input produced by {@link wrapUnparseableToolArgs}: exactly one key,
 * the marker key, holding the raw argument string. The exact-shape check
 * avoids false positives on hypothetical legitimate inputs that merely
 * contain a `_raw` field among others.
 */
export function isUnparseableToolArgs(
  input: Record<string, unknown>,
): input is { _raw: string } {
  const keys = Object.keys(input);
  return (
    keys.length === 1 &&
    keys[0] === UNPARSEABLE_TOOL_ARGS_KEY &&
    typeof input[UNPARSEABLE_TOOL_ARGS_KEY] === "string"
  );
}

/**
 * Build the error message returned to the model when it sends unparseable
 * tool arguments. Includes a bounded prefix of what was received so the model
 * can see where its output was cut off or malformed.
 */
export function unparseableToolArgsMessage(
  toolName: string,
  raw: string,
): string {
  const PREVIEW_LIMIT = 200;
  const preview =
    raw.length > PREVIEW_LIMIT ? `${raw.slice(0, PREVIEW_LIMIT)}…` : raw;
  return (
    `Error: the arguments for "${toolName}" were not valid JSON — the argument stream was malformed or truncated, so the tool was NOT executed. ` +
    `Received: ${preview || "(empty)"}\n` +
    `Retry the call with complete, valid JSON arguments.`
  );
}
