import type { LLMCallSite } from "../config/schemas/llm.js";
import { buildToolDefinitions } from "../daemon/conversation-tool-setup.js";
import { buildSystemPrompt } from "../prompts/system-prompt.js";
import {
  createTimeout,
  extractAllText,
  userMessage,
} from "../providers/provider-send-message.js";
import type {
  Message,
  Provider,
  ProviderEvent,
  ProviderResponse,
  ToolDefinition,
} from "../providers/types.js";

export interface BtwSidechainConversationLike {
  provider: Provider;
  systemPrompt: string;
  hasSystemPromptOverride?: boolean;
  getMessages(): Message[];
}

export interface RunBtwSidechainParams {
  content: string;
  conversation?: BtwSidechainConversationLike;
  provider?: Provider;
  messages?: Message[];
  systemPrompt?: string;
  tools?: ToolDefinition[];
  maxTokens?: number;
  /**
   * Unified call-site identifier. The provider layer resolves
   * provider/model/maxTokens/effort/speed/temperature/thinking/contextWindow
   * via `resolveCallSiteConfig(callSite, config.llm)`. Defaults to
   * `'identityIntro'` since this side-chain runner was originally introduced
   * for the identity intro generation path; callers (greeting, title, etc.)
   * override it with their own call-site ID.
   */
  callSite?: LLMCallSite;
  signal?: AbortSignal;
  timeoutMs?: number;
  onEvent?: (event: ProviderEvent) => void;
  userPersona?: string | null;
  channelPersona?: string | null;
  userSlug?: string | null;
}

export interface RunBtwSidechainResult {
  text: string;
  hadTextDeltas: boolean;
  response: ProviderResponse;
}

/**
 * Run an ephemeral BTW-style side-chain LLM call.
 *
 * This mirrors the /v1/btw route behavior: no message persistence, tool_choice
 * forced to none, latency-optimized by default, and the standard system prompt
 * with BOOTSTRAP.md excluded unless an explicit system prompt override exists.
 */
export async function runBtwSidechain(
  params: RunBtwSidechainParams,
): Promise<RunBtwSidechainResult> {
  const trimmedContent = params.content.trim();
  const provider = params.provider ?? params.conversation?.provider;
  if (!provider) {
    throw new Error("BTW side-chain requires a provider");
  }

  const tools = params.tools ?? buildToolDefinitions();
  const history = params.messages ?? params.conversation?.getMessages() ?? [];
  const messages = [...history, userMessage(trimmedContent)];
  const systemPrompt =
    params.systemPrompt ??
    (params.conversation?.hasSystemPromptOverride
      ? params.conversation.systemPrompt
      : buildSystemPrompt({
          excludeBootstrap: true,
          userPersona: params.userPersona,
          channelPersona: params.channelPersona,
          userSlug: params.userSlug,
        }));

  const { signal: timeoutSignal, cleanup } = createTimeout(
    params.timeoutMs ?? 30_000,
  );
  const combinedSignal = params.signal
    ? AbortSignal.any([params.signal, timeoutSignal])
    : timeoutSignal;

  let collectedText = "";
  let hadTextDeltas = false;

  try {
    const response = await provider.sendMessage(messages, tools, systemPrompt, {
      config: {
        max_tokens: params.maxTokens ?? 1024,
        tool_choice: { type: "none" },
        // Resolution: explicit callSite → default "identityIntro" (the
        // original purpose of this side-chain runner). The legacy
        // `modelIntent` parameter was removed in PR 19 of the
        // unify-llm-callsites plan.
        callSite: params.callSite ?? ("identityIntro" as LLMCallSite),
      },
      onEvent: (event) => {
        if (event.type === "text_delta") {
          hadTextDeltas = true;
          collectedText += event.text;
        }
        params.onEvent?.(event);
      },
      signal: combinedSignal,
    });

    const text = collectedText.trim() || extractAllText(response).trim();
    return { text, hadTextDeltas, response };
  } finally {
    cleanup();
  }
}
