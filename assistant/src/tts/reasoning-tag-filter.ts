/**
 * Streaming reasoning-tag filter for the TTS pipelines.
 *
 * Some OpenAI-compatible reasoning models emit their chain of thought inline
 * in the content stream as `<think>...</think>` (or `<thinking>...</thinking>`)
 * spans. When a profile has not opted into the chat-completions provider's
 * `parseThinkTags` (which re-routes those spans to `thinking_delta`), the raw
 * reasoning rides `text_delta`, and anything downstream that speaks text
 * deltas would read the model's inner monologue aloud and delay real speech
 * by the full length of the reasoning.
 *
 * This filter is the TTS-boundary guard: voice output must never speak
 * reasoning regardless of profile configuration. It is stateful because a
 * tag or a reasoning span routinely crosses delta boundaries; feed every
 * delta through {@link ReasoningTagFilter.push} and call
 * {@link ReasoningTagFilter.flush} when the turn's stream ends.
 *
 * Display paths are deliberately untouched: `assistant_text_delta` frames
 * keep the raw text, exactly like the markdown handling in
 * `calls/tts-text-sanitizer.ts`.
 *
 * Tag scanning lives in `util/think-tag-stream.ts`, shared with the
 * chat-completions provider's think-tag router, and is positionally exact
 * on the original string (no full-string lowercasing, which shifts indexes
 * for characters like the dotted capital I).
 */

import { indexOfTag, partialTagSuffix } from "../util/think-tag-stream.js";

const OPEN_TAGS = ["<think>", "<thinking>"] as const;
const CLOSE_TAGS = ["</think>", "</thinking>"] as const;

export class ReasoningTagFilter {
  private insideReasoning = false;
  private pending = "";

  /**
   * Feed one streamed delta; returns the speakable text it releases.
   * Reasoning spans are dropped; a partial tag at the end of the buffer is
   * held back until the next delta disambiguates it.
   */
  push(text: string): string {
    this.pending += text;
    let out = "";
    for (;;) {
      if (this.insideReasoning) {
        const close = indexOfTag(this.pending, CLOSE_TAGS, true);
        if (close) {
          this.pending = this.pending.slice(close.index + close.tag.length);
          this.insideReasoning = false;
          continue;
        }
        // Everything buffered is reasoning except a possible partial close
        // tag at the end; drop the reasoning, keep the partial.
        const partial = partialTagSuffix(this.pending, CLOSE_TAGS, true);
        this.pending = partial > 0 ? this.pending.slice(-partial) : "";
        return out;
      }
      const open = indexOfTag(this.pending, OPEN_TAGS, true);
      if (open) {
        out += this.pending.slice(0, open.index);
        this.pending = this.pending.slice(open.index + open.tag.length);
        this.insideReasoning = true;
        continue;
      }
      const partial = partialTagSuffix(this.pending, OPEN_TAGS, true);
      const safeLength = this.pending.length - partial;
      out += this.pending.slice(0, safeLength);
      this.pending = partial > 0 ? this.pending.slice(safeLength) : "";
      return out;
    }
  }

  /**
   * End of stream: release any held-back partial. Outside a reasoning span a
   * dangling "<thin" was ordinary text after all; inside one, the span never
   * closed and its content stays dropped.
   */
  flush(): string {
    const rest = this.insideReasoning ? "" : this.pending;
    this.pending = "";
    this.insideReasoning = false;
    return rest;
  }
}

export function createReasoningTagFilter(): ReasoningTagFilter {
  return new ReasoningTagFilter();
}
