/**
 * Whether any provider adapter would put a `file` block's bytes on the wire.
 *
 * Each adapter decides for itself what it inlines and degrades everything else
 * to a text note naming the file. A consumer that budgets the request without
 * knowing the transport (the outbound sanitizer's payload cap) needs the union
 * of those decisions, assembled here from the rules the adapters themselves
 * read so the two cannot drift:
 * - nothing {@link keepFileAsWorkspaceRef} keeps on disk (video, over-cap text);
 * - PDFs: Anthropic document blocks, Gemini inline data;
 * - decodable text under the cap: Anthropic sends it as a text document;
 * - audio Gemini takes inline ({@link normalizeGeminiAudioMime}, within its
 *   size cap);
 * - audio OpenAI-compatible adapters take inline
 *   ({@link isOpenAICompatInlineAudio}).
 * Audio no adapter inlines (m4a, opus) and arbitrary binaries fall through.
 */

import {
  isDecodableTextMimeType,
  keepFileAsWorkspaceRef,
} from "./content-block-size.js";
import {
  GEMINI_MAX_INLINE_AUDIO_BYTES,
  normalizeGeminiAudioMime,
} from "./gemini/inline-media.js";
import { isOpenAICompatInlineAudio } from "./openai/input-audio.js";
import type { MediaSource } from "./types.js";

export function fileSourceMayBeInlined(
  source: MediaSource,
  byteLength: number,
): boolean {
  if (keepFileAsWorkspaceRef(source)) {
    return false;
  }
  const mediaType = source.media_type;
  if (mediaType === "application/pdf" || isDecodableTextMimeType(mediaType)) {
    return true;
  }
  if (
    normalizeGeminiAudioMime(mediaType) !== null &&
    byteLength <= GEMINI_MAX_INLINE_AUDIO_BYTES
  ) {
    return true;
  }
  return isOpenAICompatInlineAudio(mediaType, byteLength);
}
