/**
 * Names the background subagent that finishes a live-voice reply the user
 * interrupted. The label is what the Activity panel shows, what the subagent's
 * own conversation is titled from, and what the parent's completion notices
 * quote, so it has to read as work rather than as an internal identifier.
 *
 * Two sources, in order: a fast model phrases the interrupted transcript as an
 * action ("Checking tomorrow's calendar"), and when that call misses, declines,
 * or is aborted, the transcript itself stands in, cut to title length.
 */

import {
  requestShortLabel,
  type ShortLabelTool,
} from "../providers/forced-tool-label.js";
import { getConfiguredProvider } from "../providers/provider-send-message.js";
import type { Provider } from "../providers/types.js";
import { truncateTitle } from "../util/short-title.js";

// Shown when barge-in fires before any final transcript has landed, so there
// is no request text to name the continuation from.
export const DUPLEX_CONTINUATION_FALLBACK_LABEL =
  "Finishing an interrupted reply";

/**
 * Deterministic label: the interrupted request in the user's own words, cut to
 * conversation-title length so it reads like the rows around it.
 */
export function buildDuplexContinuationLabel(
  interruptedRequest: string,
): string {
  const collapsed = interruptedRequest.replace(/\s+/g, " ").trim();
  if (collapsed.length === 0) {
    return DUPLEX_CONTINUATION_FALLBACK_LABEL;
  }
  return truncateTitle(collapsed.charAt(0).toUpperCase() + collapsed.slice(1));
}

/**
 * Asks a model to name the continuation. Resolves to the label, or null when
 * no provider is configured or the model declined; rejects on abort or
 * timeout. The session treats every non-label outcome the same way, by
 * falling back to `buildDuplexContinuationLabel`. Injected into the session
 * for testability; the factory wires the provider-backed implementation.
 */
export type LiveVoiceContinuationLabeler = (args: {
  parentConversationId: string;
  interruptedRequest: string;
  signal: AbortSignal;
}) => Promise<string | null>;

// The label is fixed at spawn, so the model call delays the handoff by
// whatever it takes beyond the teardown wait it overlaps. The continuation is
// background work whose result arrives seconds to minutes later, so a bounded
// wait is invisible to the user, and past the bound the transcript is a good
// enough name.
export const CONTINUATION_LABEL_TIMEOUT_MS = 3_000;

const CONTINUATION_LABEL_TOOL: ShortLabelTool = {
  name: "record_task_label",
  description:
    "Record the task's name. Call this exactly once with a short action phrase saying what is being done for the user — never a sentence, a reply, or any preamble.",
  argument: "label",
  argumentDescription:
    "2–5 words, 40 characters max. A present-tense action phrase naming the work (e.g. 'Checking tomorrow's calendar', 'Drafting the reply to Sam'). No quotes, markdown, or trailing punctuation.",
};

const CONTINUATION_LABEL_SYSTEM_PROMPT = [
  "You name background tasks for an activity list. The user asked a voice assistant for something, interrupted it mid-reply, and the assistant is finishing that request in the background. Output ONLY the task name, through the tool.",
  "",
  "Rules:",
  "- 2–5 words, 40 characters absolute maximum",
  "- A present-tense action phrase describing the work (e.g. 'Checking tomorrow's calendar', 'Finding flights to Denver')",
  "- Drop filler, hesitation, and politeness from the transcript; keep the specifics (names, dates, subjects)",
  "- Do NOT answer the request, ask a question, or comment on it",
  "- If the transcript is vague, name what CAN be inferred (e.g. 'so about that thing' → 'Following up on the earlier topic'). Never describe the transcript as unclear or empty",
].join("\n");

export function createContinuationLabeler(options?: {
  /** Provider resolver, injectable for tests. */
  getProvider?: () => Promise<Provider | null>;
}): LiveVoiceContinuationLabeler {
  const getProvider =
    options?.getProvider ??
    (() => getConfiguredProvider("voiceContinuationLabel"));
  return async (args) => {
    const provider = await getProvider();
    if (!provider) {
      return null;
    }
    const label = await requestShortLabel({
      provider,
      callSite: "voiceContinuationLabel",
      conversationId: args.parentConversationId,
      systemPrompt: CONTINUATION_LABEL_SYSTEM_PROMPT,
      prompt: `Interrupted request (voice transcript):\n\n${args.interruptedRequest}`,
      tool: CONTINUATION_LABEL_TOOL,
      timeoutMs: CONTINUATION_LABEL_TIMEOUT_MS,
      maxTokens: 64,
      signal: args.signal,
    });
    return label.length > 0 ? label : null;
  };
}
