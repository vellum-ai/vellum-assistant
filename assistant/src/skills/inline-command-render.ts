/**
 * Renderer for inline command expansion tokens in skill bodies.
 *
 * Given a skill body and its parsed `InlineCommandExpansion` descriptors,
 * replaces each `!\`command\`` token by executing the command through the
 * sandbox-only runner and wrapping the result in XML tags:
 *
 *   <inline_skill_command index="0">...output...</inline_skill_command>
 *
 * Render failures produce stable inline stubs rather than dumping raw
 * shell stderr into the prompt:
 *
 *   <inline_skill_command index="0">[inline command unavailable: <reason>]</inline_skill_command>
 */

import { getLogger } from "../util/logger.js";
import type { InlineCommandExpansion } from "./inline-command-expansions.js";
import type { InlineCommandResult } from "./inline-command-runner.js";
import { runInlineCommand } from "./inline-command-runner.js";

const log = getLogger("inline-command-render");

// ─── Types ────────────────────────────────────────────────────────────────────

/** Result of rendering all inline command expansions in a skill body. */
export interface InlineCommandRenderResult {
  /** The body with all inline command tokens replaced. */
  renderedBody: string;
  /** Count of successfully expanded tokens. */
  expandedCount: number;
  /** Count of tokens that failed to expand (rendered as stubs). */
  failedCount: number;
}

// ─── Failure reason mapping ───────────────────────────────────────────────────

/**
 * Map a machine-readable failure reason to a human-readable stub message
 * suitable for inclusion in the prompt. These messages are intentionally
 * terse and deterministic so they don't leak raw stderr or confuse the LLM.
 */
function failureReasonToStub(result: InlineCommandResult): string {
  switch (result.failureReason) {
    case "timeout":
      return "command timed out";
    case "non_zero_exit":
      return "command failed";
    case "binary_output":
      return "command produced binary output";
    case "spawn_failure":
      return "command could not be started";
    default:
      return "unknown error";
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Render all inline command expansion tokens in a skill body.
 *
 * Each `!\`command\`` token is executed through the sandbox-only runner and
 * replaced with its output wrapped in XML tags. Expansions are processed
 * sequentially (not in parallel) to keep execution order deterministic and
 * avoid overwhelming the sandbox.
 *
 * @param body  The skill body containing `!\`command\`` tokens.
 * @param expansions  Parsed expansion descriptors from `parseInlineCommandExpansions`.
 * @param workingDir  The conversation's working directory (repo root).
 */
export async function renderInlineCommands(
  body: string,
  expansions: InlineCommandExpansion[],
  workingDir: string,
): Promise<InlineCommandRenderResult> {
  if (expansions.length === 0) {
    return { renderedBody: body, expandedCount: 0, failedCount: 0 };
  }

  let expandedCount = 0;
  let failedCount = 0;

  // Process replacements in reverse offset order so that earlier offsets
  // remain valid after splicing in replacement text.
  const sorted = [...expansions].sort((a, b) => b.startOffset - a.startOffset);

  let result = body;

  for (const expansion of sorted) {
    const commandResult = await runInlineCommand(expansion.command, workingDir);

    let replacement: string;
    if (commandResult.ok) {
      replacement = wrapInXml(expansion.placeholderId, commandResult.output);
      expandedCount++;
    } else {
      const stub = failureReasonToStub(commandResult);
      replacement = wrapInXml(
        expansion.placeholderId,
        `[inline command unavailable: ${stub}]`,
      );
      failedCount++;
      log.warn(
        {
          command: expansion.command,
          placeholderId: expansion.placeholderId,
          failureReason: commandResult.failureReason,
        },
        "Inline command expansion failed, rendering stub",
      );
    }

    // Replace the original token with the rendered output
    result =
      result.slice(0, expansion.startOffset) +
      replacement +
      result.slice(expansion.endOffset);
  }

  return { renderedBody: result, expandedCount, failedCount };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function wrapInXml(index: number, content: string): string {
  return `<inline_skill_command index="${index}">${content}</inline_skill_command>`;
}
