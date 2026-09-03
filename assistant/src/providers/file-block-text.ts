/**
 * Shared file-block → provider text. OpenAI, Anthropic, and Gemini all fold
 * non-native files into a text part. Video is never inlined: it stays a
 * workspace file and the prompt only names it.
 */

import { escapeXmlAttr } from "../util/xml.js";
import { clampProviderString, isVideoMimeType } from "./content-block-size.js";
import type { ContentBlock } from "./types.js";

const VIDEO_FILE_NOTE =
  "Video is stored as a workspace file. It is not inlined in this prompt.";

export function fileBlockToProviderText(
  block: Extract<ContentBlock, { type: "file" }>,
): string {
  const header = `<attached_file name="${escapeXmlAttr(
    block.source.filename ?? "",
  )}" type="${escapeXmlAttr(block.source.media_type)}" />`;
  if (isVideoMimeType(block.source.media_type)) {
    return `${header}\n${VIDEO_FILE_NOTE}`;
  }
  const extracted = block.extracted_text?.trim() ?? "";
  if (extracted.length > 0) {
    return clampProviderString(`${header}\n${extracted}`);
  }
  return `${header}\nNo extracted text available.`;
}
