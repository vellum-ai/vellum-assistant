/**
 * Terminal handler for the default `toolResultTruncate` pipeline.
 *
 * This module is side-effect free: importing it does not register any plugin.
 * The terminal is wired in as the pipeline's `terminal` argument by the
 * `runPipeline` call site in `agent/loop.ts`.
 *
 * Design doc: `.private/plans/agent-plugin-system.md` (PR 17).
 */

import { truncateToolResultText } from "../../../context/tool-result-truncation.js";
import type {
  ToolResultTruncateArgs,
  ToolResultTruncateResult,
} from "../../types.js";

/**
 * Terminal handler for the `toolResultTruncate` pipeline. Exported so tests
 * can verify default behavior directly without going through `runPipeline`,
 * and so `agent/loop.ts` can pass it as the `terminal` argument to
 * `runPipeline`.
 */
export function defaultToolResultTruncateTerminal(
  args: ToolResultTruncateArgs,
): ToolResultTruncateResult {
  const truncated = truncateToolResultText(args.content, args.maxChars);
  return {
    content: truncated,
    truncated: truncated !== args.content,
  };
}
