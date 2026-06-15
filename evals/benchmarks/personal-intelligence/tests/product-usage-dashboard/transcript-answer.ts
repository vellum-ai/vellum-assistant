import {
  readAssistantEvents,
  readTranscript,
} from "../../../../src/lib/metrics";
import { buildTranscriptView } from "../../../../src/lib/transcript-view";

/**
 * Folds the run's event stream back into whole assistant messages.
 *
 * The Vellum stream lands one transcript turn per `assistant_text_delta`, so a
 * single answer is spread across many fragment turns. `buildTranscriptView`
 * coalesces consecutive deltas into whole messages (splitting only on simulator
 * turns) and keeps thinking blocks separate from text, so callers grade the
 * actual visible answer rather than a trailing token or a reasoning fragment.
 */
async function readAssistantMessages(runId: string): Promise<string[]> {
  const [turns, events] = await Promise.all([
    readTranscript(runId),
    readAssistantEvents(runId),
  ]);
  return buildTranscriptView(turns, events)
    .filter((item) => item.role === "assistant")
    .map((message) =>
      message.blocks
        .filter((block) => block.kind === "text")
        .map((block) => block.text)
        .join(""),
    );
}

/** The assistant's final answer message, or undefined if it never answered. */
export async function readFinalAnswer(
  runId: string,
): Promise<string | undefined> {
  return (await readAssistantMessages(runId)).at(-1);
}

/**
 * Every assistant message joined in order. Detecting whether a dashboard was
 * delivered needs the whole side of the conversation, since the agent often
 * announces the artifact ("saved the dashboard to product-usage.html") on an
 * earlier turn than its closing summary.
 */
export async function readAssistantNarration(
  runId: string,
): Promise<string | undefined> {
  const messages = (await readAssistantMessages(runId)).filter(
    (text) => text.trim() !== "",
  );
  return messages.length === 0 ? undefined : messages.join("\n\n");
}
