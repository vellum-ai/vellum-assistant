// Type-only import: this binds the mock to the real `Provider` contract so it
// can be passed to a live `AgentLoop` without casts. It must stay `import type`
// — a value import would pull `providers/types.ts`'s runtime exports into this
// shared helper, which the test-machinery isolation rule forbids.
import type {
  Message,
  Provider,
  ProviderResponse,
  SendMessageOptions,
  ToolDefinition,
} from "../../providers/types.js";

/**
 * Records the arguments of a single `provider.sendMessage` invocation so tests
 * can assert on what the agent loop sent (messages, tools, system prompt, the
 * resolved options bag).
 */
export interface RecordedProviderCall {
  messages: Message[];
  tools?: ToolDefinition[];
  systemPrompt?: string;
  options?: SendMessageOptions;
}

/**
 * One scripted provider turn. A `ProviderResponse` is returned normally; an
 * `Error` is thrown to simulate a provider HTTP rejection (e.g. a
 * context-too-large error the orchestrator must recover from).
 */
export type ScriptedResponse = ProviderResponse | Error;

/**
 * A mock provider that returns pre-configured responses in sequence.
 *
 * Drives the real {@link import("../../agent/loop.js").AgentLoop} by mocking
 * only the provider HTTP boundary: each call returns the next scripted
 * `ProviderResponse` (the last response repeats once the script is exhausted)
 * and replays its text blocks as `text_delta` events so the loop streams
 * exactly as it would against a live provider. A scripted `Error` entry is
 * thrown instead of returned, so a rejection can be sequenced before a
 * recovery response.
 */
export function createMockProvider(
  responses: ScriptedResponse[],
  name = "mock",
): {
  provider: Provider;
  calls: RecordedProviderCall[];
} {
  const calls: RecordedProviderCall[] = [];
  let callIndex = 0;

  const provider: Provider = {
    name,
    async sendMessage(
      messages: Message[],
      options?: SendMessageOptions,
    ): Promise<ProviderResponse> {
      calls.push({
        messages: [...messages],
        tools: options?.tools,
        systemPrompt: options?.systemPrompt,
        options,
      });
      const scripted = responses[callIndex] ?? responses[responses.length - 1];
      callIndex++;

      if (scripted instanceof Error) {
        throw scripted;
      }

      // Replay streaming deltas for text blocks, mirroring a live provider.
      if (options?.onEvent) {
        for (const block of scripted.content) {
          if (block.type === "text") {
            options.onEvent({ type: "text_delta", text: block.text });
          }
        }
      }

      return scripted;
    },
  };

  return { provider, calls };
}

/** A scripted assistant turn that ends with a plain text response. */
export function textResponse(text: string): ProviderResponse {
  return {
    content: [{ type: "text", text }],
    model: "mock-model",
    usage: { inputTokens: 10, outputTokens: 5 },
    stopReason: "end_turn",
  };
}

/** A scripted assistant turn that invokes a single tool. */
export function toolUseResponse(
  id: string,
  name: string,
  input: Record<string, unknown>,
): ProviderResponse {
  return {
    content: [{ type: "tool_use", id, name, input }],
    model: "mock-model",
    usage: { inputTokens: 10, outputTokens: 5 },
    stopReason: "tool_use",
  };
}
