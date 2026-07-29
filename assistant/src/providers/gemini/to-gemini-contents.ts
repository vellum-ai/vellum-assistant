/**
 * Serialization of neutral message history into Gemini's `Content[]` wire
 * shape.
 *
 * The one rule that shapes most of this module: a `Content` carrying
 * `functionResponse` parts must carry nothing else. Gemini segments turns on
 * that Content, so any sibling text or `inlineData` part breaks segmentation
 * and the request is rejected with
 * `Requests ending with a model turn are not supported.` Our agent loop
 * routinely produces such mixed user messages (tool results plus
 * `<system_notice>` text on an errored call, or compaction merging context text
 * into the tool-result message), so a mixed message is split into a
 * function-response-only Content followed by a second user Content holding
 * everything else.
 */

import type * as genai from "@google/genai";

import { base64Source, resolveMediaReferences } from "../media-resolve.js";
import type { ContentBlock, Message } from "../types.js";
import {
  base64ByteLength,
  GEMINI_MAX_INLINE_AUDIO_BYTES,
  normalizeGeminiAudioMime,
} from "./inline-media.js";

const GEMINI_3_UNSIGNED_TOOL_CALL_THOUGHT_SIGNATURE =
  "context_engineering_is_the_way_to_go";

function isGemini3Model(model: string): boolean {
  return model.startsWith("gemini-3") || model.startsWith("models/gemini-3");
}

function supportsGeminiInlineFile(mimeType: string): boolean {
  return (
    mimeType === "application/pdf" ||
    normalizeGeminiAudioMime(mimeType) !== null
  );
}

/** Convert neutral messages to Gemini Content[] format. */
export function toGeminiContents(
  messages: Message[],
  model: string,
): genai.Content[] {
  // Swap any persisted attachment references back to inline base64 before
  // building parts, so the transforms below can read `source.data`.
  const resolved = resolveMediaReferences(messages);
  const result: genai.Content[] = [];

  // Build a map from tool_use id → function name so tool_result blocks
  // can provide the required `name` field on Gemini's FunctionResponse.
  const toolCallNames = new Map<string, string>();
  for (const msg of resolved) {
    for (const block of msg.content) {
      if (block.type === "tool_use") {
        toolCallNames.set(block.id, block.name);
      }
    }
  }

  for (const msg of resolved) {
    const role = msg.role === "assistant" ? "model" : "user";
    const { parts, toolResultMediaParts } = toGeminiParts(
      msg.content,
      toolCallNames,
      model,
      role,
    );

    const functionResponseParts = parts.filter((part) => part.functionResponse);
    if (functionResponseParts.length > 0) {
      // The function-response Content stays immediately after the model turn
      // that called the tools, holding nothing but the responses. Everything
      // else the message carried rides a follow-up user Content: message-level
      // parts first (in block order), then media lifted out of the tool
      // results.
      result.push({ role, parts: functionResponseParts });
      const followUpParts = [
        ...parts.filter((part) => !part.functionResponse),
        ...toolResultMediaParts,
      ];
      if (followUpParts.length > 0) {
        result.push({ role: "user", parts: followUpParts });
      }
      continue;
    }

    if (parts.length > 0) {
      result.push({ role, parts });
    }
    if (toolResultMediaParts.length > 0) {
      result.push({ role: "user", parts: toolResultMediaParts });
    }
  }

  return result;
}

/** Convert ContentBlock[] to Gemini Part[] and any tool-result image parts. */
function toGeminiParts(
  blocks: ContentBlock[],
  toolCallNames: Map<string, string>,
  model: string,
  role: "model" | "user",
): { parts: genai.Part[]; toolResultMediaParts: genai.Part[] } {
  const parts: genai.Part[] = [];
  const toolResultMediaParts: genai.Part[] = [];

  for (const block of blocks) {
    switch (block.type) {
      case "text":
        parts.push({ text: block.text });
        break;
      case "image": {
        const imageSrc = base64Source(block.source);
        parts.push({
          inlineData: {
            mimeType: imageSrc.media_type,
            data: imageSrc.data,
          },
        });
        break;
      }
      case "file": {
        const fileSrc = base64Source(block.source);
        if (supportsGeminiInlineFile(fileSrc.media_type)) {
          // Normalize audio MIME onto Gemini's spelling (e.g. audio/mpeg →
          // audio/mp3); PDFs pass through unchanged. Guard the 20 MB inline
          // request limit for audio so an oversize clip degrades to a text
          // note rather than 400ing the whole request.
          const audioMime = normalizeGeminiAudioMime(fileSrc.media_type);
          const rawBytes = base64ByteLength(fileSrc.data);
          if (audioMime && rawBytes > GEMINI_MAX_INLINE_AUDIO_BYTES) {
            const approxMb = Math.round(rawBytes / (1024 * 1024));
            parts.push({
              text: `[Audio file too large to send inline: ${fileSrc.filename} (${fileSrc.media_type}, ~${approxMb}MB). Gemini's inline request limit is 20MB; this file was omitted. Ask the user for a shorter clip.]`,
            });
          } else {
            parts.push({
              inlineData: {
                mimeType: audioMime ?? fileSrc.media_type,
                data: fileSrc.data,
              },
            });
          }
        } else {
          const fallback = block.extracted_text?.trim()
            ? `[Attached file: ${fileSrc.filename} (${fileSrc.media_type})]\n${block.extracted_text}`
            : `[Attached file: ${fileSrc.filename} (${fileSrc.media_type})]\nNo extracted text available.`;
          parts.push({ text: fallback });
        }
        break;
      }
      case "tool_use":
        {
          const functionCallPart: genai.Part = {
            functionCall: {
              name: block.name,
              args: block.input,
            },
          };
          const thoughtSignature =
            block.providerMetadata?.gemini?.thoughtSignature;
          if (thoughtSignature) {
            functionCallPart.thoughtSignature = thoughtSignature;
          }
          parts.push(functionCallPart);
        }
        break;
      case "tool_result": {
        let outputText = block.content;
        if (block.contentBlocks && block.contentBlocks.length > 0) {
          const extraText = block.contentBlocks
            .filter(
              (cb): cb is Extract<ContentBlock, { type: "text" }> =>
                cb.type === "text",
            )
            .map((cb) => cb.text);
          if (extraText.length > 0) {
            outputText = outputText + "\n" + extraText.join("\n");
          }
          // Collect images and inline-able audio separately: Gemini rejects
          // mixing inlineData with functionResponse in the same Content entry.
          for (const cb of block.contentBlocks) {
            if (cb.type === "image") {
              const cbSrc = base64Source(cb.source);
              toolResultMediaParts.push({
                inlineData: {
                  mimeType: cbSrc.media_type,
                  data: cbSrc.data,
                },
              });
            } else if (cb.type === "file") {
              const cbSrc = base64Source(cb.source);
              const audioMime = normalizeGeminiAudioMime(cbSrc.media_type);
              if (
                audioMime &&
                base64ByteLength(cbSrc.data) <= GEMINI_MAX_INLINE_AUDIO_BYTES
              ) {
                toolResultMediaParts.push({
                  inlineData: { mimeType: audioMime, data: cbSrc.data },
                });
              } else if (audioMime) {
                // Oversize audio: note it in the functionResponse output
                // rather than a media part (a text part can't ride the
                // separate media Content, and inline audio would blow
                // Gemini's request-size limit).
                outputText =
                  outputText +
                  `\n[Audio too large to send inline: ${cbSrc.filename}. Ask for a shorter clip.]`;
              }
              // Non-inline-able file sub-blocks (m4a/opus/pdf) are skipped
              // here; the tool's text output already conveys the file.
            }
          }
        }
        parts.push({
          functionResponse: {
            name: toolCallNames.get(block.tool_use_id) ?? block.tool_use_id,
            response: { output: outputText },
          },
        });
        break;
      }
      case "server_tool_use":
        parts.push({ text: `[Web search: ${block.name}]` });
        break;
      case "web_search_tool_result":
        parts.push({ text: "[Web search results]" });
        break;
      // thinking, redacted_thinking: not applicable for Gemini
    }
  }

  if (role === "model") {
    addGemini3UnsignedToolCallFallback(parts, model);
  }

  return { parts, toolResultMediaParts };
}

function addGemini3UnsignedToolCallFallback(
  parts: genai.Part[],
  model: string,
): void {
  if (!isGemini3Model(model)) {
    return;
  }

  const functionCallParts = parts.filter((part) => part.functionCall);
  if (functionCallParts.length === 0) {
    return;
  }

  const hasRealThoughtSignature = functionCallParts.some((part) =>
    Boolean(part.thoughtSignature),
  );
  if (hasRealThoughtSignature) {
    return;
  }

  const firstFunctionCallPart = functionCallParts[0];
  if (!firstFunctionCallPart) {
    return;
  }
  firstFunctionCallPart.thoughtSignature =
    GEMINI_3_UNSIGNED_TOOL_CALL_THOUGHT_SIGNATURE;
}
