/**
 * One forced-tool call that returns a short label: a conversation title, a
 * background task name, anything a small fast model should name in a few
 * words. Forcing the tool is what keeps a weak model from thinking aloud or
 * replying to the content instead of naming it; `normalizeTitle` is the
 * backstop for a provider that ignores `tool_choice` and answers in prose.
 * Resolves to "" when the model declines or misbehaves, so every caller keeps
 * a deterministic fallback of its own. Rejects on abort or timeout.
 */

import type { LLMCallSite } from "../config/schemas/llm.js";
import { normalizeTitle } from "../util/short-title.js";
import {
  createTimeout,
  extractAllText,
  extractToolUse,
  userMessage,
} from "./provider-send-message.js";
import type { Provider, ToolDefinition } from "./types.js";

export interface ShortLabelTool {
  name: string;
  description: string;
  /** The single string argument the model fills in. */
  argument: string;
  argumentDescription: string;
}

export function buildShortLabelTool(tool: ShortLabelTool): ToolDefinition {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: {
      type: "object",
      properties: {
        [tool.argument]: {
          type: "string",
          description: tool.argumentDescription,
        },
      },
      required: [tool.argument],
    },
  };
}

export async function requestShortLabel(args: {
  provider: Provider;
  callSite: LLMCallSite;
  conversationId?: string;
  systemPrompt: string;
  prompt: string;
  tool: ShortLabelTool;
  timeoutMs: number;
  maxTokens: number;
  signal?: AbortSignal;
}): Promise<string> {
  const { signal: timeoutSignal, cleanup } = createTimeout(args.timeoutMs);
  const combinedSignal = args.signal
    ? AbortSignal.any([args.signal, timeoutSignal])
    : timeoutSignal;
  try {
    const response = await args.provider.sendMessage(
      [userMessage(args.prompt)],
      {
        tools: [buildShortLabelTool(args.tool)],
        systemPrompt: args.systemPrompt,
        config: {
          max_tokens: args.maxTokens,
          callSite: args.callSite,
          ...(args.conversationId !== undefined
            ? { conversationId: args.conversationId }
            : {}),
          tool_choice: { type: "tool", name: args.tool.name },
          disableCache: true,
        },
        signal: combinedSignal,
      },
    );
    const toolBlock = extractToolUse(response);
    const input = toolBlock?.input as Record<string, unknown> | undefined;
    const value = input?.[args.tool.argument];
    if (toolBlock?.name === args.tool.name && typeof value === "string") {
      return normalizeTitle(value);
    }
    // The provider ignored the forced tool, or the model answered in prose.
    // `normalizeTitle`'s prose guard rejects a ramble while keeping a compliant
    // plain-text label.
    return normalizeTitle(extractAllText(response));
  } finally {
    cleanup();
  }
}
