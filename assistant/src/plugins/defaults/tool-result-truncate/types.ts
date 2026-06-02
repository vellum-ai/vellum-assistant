/**
 * Argument and result shapes for the default `toolResultTruncate` behavior.
 */

/**
 * Input to tool-result truncation: the raw tool-result text and the character
 * budget the caller computed from the context-window share.
 */
export type ToolResultTruncateArgs = {
  readonly content: string;
  readonly maxChars: number;
};

/**
 * Output of tool-result truncation: the (possibly truncated) content and a
 * boolean indicating whether the input was actually shortened. Callers use
 * `truncated` for telemetry / warnings.
 */
export type ToolResultTruncateResult = {
  readonly content: string;
  readonly truncated: boolean;
};
