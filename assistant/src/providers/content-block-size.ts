/**
 * Provider per-string size cap and helpers for content that would be
 * serialized as a single text part.
 *
 * OpenAI rejects a request when any `content[].text` / `input[].content[].text`
 * exceeds 10_485_760 bytes (`string_above_max_length`). Stay under that so a
 * single block cannot brick every later turn. Extra SQLite-only columns and
 * attachment bytes are out of scope: this is the wire-string budget.
 */

/** Bytes. Under OpenAI's 10 MiB per-part string limit (10_485_760). */
export const MAX_PROVIDER_STRING_BYTES = 8_000_000;

export function utf8ByteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

export function exceedsProviderStringCap(
  text: string,
  maxBytes: number = MAX_PROVIDER_STRING_BYTES,
): boolean {
  return utf8ByteLength(text) > maxBytes;
}

export function isVideoMimeType(mimeType: string): boolean {
  const normalised = mimeType.toLowerCase().trim().split(";")[0]?.trim() ?? "";
  return normalised.startsWith("video/");
}

/**
 * Drop `extracted_text` that must not ride a file block into the provider
 * prompt: video is a workspace file, not a transcript dump, and any extract
 * over the cap belongs in the attachment store rather than the request.
 */
export function extractedTextForFileBlock(
  mimeType: string,
  extractedText: string | undefined,
  maxBytes: number = MAX_PROVIDER_STRING_BYTES,
): string | undefined {
  if (extractedText === undefined || extractedText.length === 0) {
    return undefined;
  }
  if (isVideoMimeType(mimeType)) {
    return undefined;
  }
  if (exceedsProviderStringCap(extractedText, maxBytes)) {
    return undefined;
  }
  return extractedText;
}

/** Fallback copy when a serializer still sees a string over the cap. */
export const PROVIDER_STRING_OMITTED_NOTE =
  "Content exceeded the provider size limit and was omitted from this prompt.";

export function clampProviderString(
  text: string,
  maxBytes: number = MAX_PROVIDER_STRING_BYTES,
): string {
  if (!exceedsProviderStringCap(text, maxBytes)) {
    return text;
  }
  return PROVIDER_STRING_OMITTED_NOTE;
}
