/**
 * Salvage Anthropic-style XML tool calls that some OpenAI-compatible models
 * emit as assistant text instead of native `tool_calls`.
 *
 * Off by default. DeepSeek model ids enable it because those models are
 * trained to emit DSML `invoke` markup and OpenAI-compatible hosts sometimes
 * leave a prefix-stripped variant in `content`. Invokes inside markdown
 * fences stay as text.
 */

import { indexOfTag, partialTagSuffix } from "../util/think-tag-stream.js";

/** Openers a streaming scanner holds back so XML tool calls are not shown as text. */
export const XML_TOOL_CALL_OPEN_TAGS = [
  "<invoke",
  "<function_calls",
  "<minimax:tool_call",
] as const;

export interface SalvagedXmlToolCall {
  name: string;
  input: Record<string, unknown>;
}

export interface XmlToolCallSalvage {
  /** Assistant text with salvaged invoke blocks removed. */
  text: string;
  calls: SalvagedXmlToolCall[];
}

const INVOKE_CLOSE = "</invoke>";
const NAME_ATTR_RE = /\bname\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;
const PARAMETER_CLOSE = "</parameter>";

const EMPTY_WRAPPER_RE =
  /<(?:function_calls|minimax:tool_call)>\s*<\/(?:function_calls|minimax:tool_call)>/gi;

/** True when the model id is a DeepSeek variant that leaks XML tool calls. */
export function shouldSalvageXmlToolCalls(
  model: string | null | undefined,
): boolean {
  return typeof model === "string" && /deepseek/i.test(model);
}

export function salvageXmlToolCalls(
  text: string,
  offeredToolNames: ReadonlySet<string>,
): XmlToolCallSalvage | null {
  if (!text || offeredToolNames.size === 0) {
    return null;
  }

  const spans: Array<{
    start: number;
    end: number;
    call: SalvagedXmlToolCall;
  }> = [];

  const invokeOpenRe = /<invoke\b[^>]*>/gi;
  let openMatch: RegExpExecArray | null = invokeOpenRe.exec(text);
  while (openMatch) {
    const openTag = openMatch[0];
    const rawName = parseNameAttr(openTag);
    const bodyStart = openMatch.index + openTag.length;
    const closeIdx = text.indexOf(INVOKE_CLOSE, bodyStart);
    if (closeIdx < 0) {
      break;
    }

    const canonicalName = rawName
      ? resolveOfferedName(rawName, offeredToolNames)
      : null;
    if (canonicalName && !isInsideMarkdownFence(text, openMatch.index)) {
      spans.push({
        start: openMatch.index,
        end: closeIdx + INVOKE_CLOSE.length,
        call: {
          name: canonicalName,
          input: parseParameters(text.slice(bodyStart, closeIdx)),
        },
      });
    }

    invokeOpenRe.lastIndex = closeIdx + INVOKE_CLOSE.length;
    openMatch = invokeOpenRe.exec(text);
  }

  if (spans.length === 0) {
    return null;
  }

  let leftover = "";
  let cursor = 0;
  for (const span of spans) {
    leftover += text.slice(cursor, span.start);
    cursor = span.end;
  }
  leftover += text.slice(cursor);
  leftover = leftover.replace(EMPTY_WRAPPER_RE, "").trim();

  return {
    text: leftover,
    calls: spans.map((span) => span.call),
  };
}

/**
 * Split streamed text so a complete or in-progress XML tool-call opener is
 * held back rather than shown as user-visible content.
 */
export function splitXmlToolCallHoldback(buffer: string): {
  visible: string;
  held: string;
} {
  if (!buffer) {
    return { visible: "", held: "" };
  }
  const hit = indexOfTag(buffer, XML_TOOL_CALL_OPEN_TAGS, false);
  if (hit) {
    return {
      visible: buffer.slice(0, hit.index),
      held: buffer.slice(hit.index),
    };
  }
  const partial = partialTagSuffix(buffer, XML_TOOL_CALL_OPEN_TAGS, false);
  if (partial > 0) {
    return {
      visible: buffer.slice(0, buffer.length - partial),
      held: buffer.slice(buffer.length - partial),
    };
  }
  return { visible: buffer, held: "" };
}

function parseNameAttr(tag: string): string | null {
  const match = NAME_ATTR_RE.exec(tag);
  if (!match) {
    return null;
  }
  const name = match[1] ?? match[2] ?? match[3];
  return name && name.length > 0 ? name : null;
}

function resolveOfferedName(
  name: string,
  offeredToolNames: ReadonlySet<string>,
): string | null {
  if (offeredToolNames.has(name)) {
    return name;
  }
  const lower = name.toLowerCase();
  for (const offered of offeredToolNames) {
    if (offered.toLowerCase() === lower) {
      return offered;
    }
  }
  return null;
}

function parseParameters(body: string): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  const parameterOpenRe = /<parameter\b[^>]*>/gi;
  let paramMatch: RegExpExecArray | null = parameterOpenRe.exec(body);
  while (paramMatch) {
    const openTag = paramMatch[0];
    const paramName = parseNameAttr(openTag);
    const valueStart = paramMatch.index + openTag.length;
    const closeIdx = body.indexOf(PARAMETER_CLOSE, valueStart);
    if (closeIdx < 0) {
      break;
    }
    if (paramName) {
      input[paramName] = parseParamValue(
        decodeXmlEntities(body.slice(valueStart, closeIdx)),
      );
    }
    parameterOpenRe.lastIndex = closeIdx + PARAMETER_CLOSE.length;
    paramMatch = parameterOpenRe.exec(body);
  }
  return input;
}

function parseParamValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function isInsideMarkdownFence(text: string, index: number): boolean {
  let inside = false;
  let searchFrom = 0;
  while (searchFrom < index) {
    const next = text.indexOf("```", searchFrom);
    if (next < 0 || next >= index) {
      break;
    }
    inside = !inside;
    searchFrom = next + 3;
  }
  return inside;
}
