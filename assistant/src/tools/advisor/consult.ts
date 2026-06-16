import { findConversation } from "../../daemon/conversation-registry.js";
import {
  extractAllText,
  getConfiguredProvider,
  userMessage,
} from "../../providers/provider-send-message.js";
import { sanitizeTranscriptForNestedInference } from "../../providers/sanitize-transcript.js";
import type { Message } from "../../providers/types.js";
import { getLogger } from "../../util/logger.js";
import type { ToolContext, ToolExecutionResult } from "../types.js";

const log = getLogger("advisor-consult");

/**
 * Advisor's own system prompt. The native advisor tool supplies this
 * server-side; for the local executor we author it here.
 */
const ADVISOR_SYSTEM_PROMPT =
  "You are a senior technical advisor reviewing another AI agent's work. You see its full conversation transcript — the task, every tool call, and every result. You have no tools and cannot ask questions: give your single best judgment. Produce a focused plan or course-correction, not a comprehensive write-up. Lead with the most important decision or risk. If the agent is about to commit to a flawed approach, say so plainly and give the better one. Keep it tight (aim for under ~120 words).";

/**
 * Run a single synchronous "consult the advisor" inference: a higher-tier model
 * reviews the executor's transcript so far and returns focused guidance, which
 * becomes the tool result.
 *
 * Error-handling decision (see `assistant/docs/error-handling.md`, pattern 2 —
 * `ToolExecutionResult` content + error flag): EVERY failure mode here degrades
 * as `isError: false`. A flaky or unavailable advisor must never abort the
 * executor's turn — it is an optional second opinion, not a load-bearing step.
 * This mirrors the native advisor tool's "the request itself does not fail"
 * behavior. Do NOT switch these to `isError: true`.
 */
export async function executeAdvisorConsult(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  const focus = input.focus as string | undefined;

  const conversation = findConversation(context.conversationId);
  if (!conversation) {
    return {
      content: "Advisor unavailable: conversation could not be resolved.",
      isError: false,
    };
  }

  const base = sanitizeTranscriptForNestedInference(
    [...conversation.messages],
    context.toolUseId ? { dropToolUseId: context.toolUseId } : undefined,
  );
  if (base.length === 0) {
    return { content: "Nothing to advise on yet.", isError: false };
  }

  const nudge =
    "(Advisor: keep your guidance under ~120 words — a focused plan or course-correction, not a comprehensive write-up.)";
  const ask = focus
    ? `${focus}\n\n${nudge}`
    : `Review the work so far and advise on the best next step or any course-correction.\n\n${nudge}`;
  const messages: Message[] = [...base, userMessage(ask)];

  try {
    // Provider resolution stays inside the soft-fail path: a misconfigured
    // advisor call site (stale provider_connection, DB lookup failure, invalid
    // profile) can make getConfiguredProvider throw, and the advisor must never
    // abort the executor's turn — degrade to isError:false like every other
    // failure mode here.
    const provider = await getConfiguredProvider("advisor");
    if (!provider) {
      return {
        content:
          "Advisor unavailable: no higher-tier model is configured or reachable.",
        isError: false,
      };
    }

    const response = await provider.sendMessage(messages, {
      systemPrompt: ADVISOR_SYSTEM_PROMPT,
      config: { callSite: "advisor" },
      signal: context.signal,
    });
    const advice = extractAllText(response).trim();
    if (!advice) {
      return { content: "Advisor returned no guidance.", isError: false };
    }
    return { content: advice, isError: false };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn({ err }, "advisor consult failed");
    return { content: `Advisor consult failed: ${msg}`, isError: false };
  }
}
