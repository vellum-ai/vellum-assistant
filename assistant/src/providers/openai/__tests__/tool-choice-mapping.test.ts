import { describe, expect, test } from "bun:test";

import type { Message, ToolDefinition } from "../../types.js";
import {
  mapNeutralToolChoice,
  OpenAIChatCompletionsProvider,
} from "../chat-completions-provider.js";
import { mapNeutralToolChoiceForResponses } from "../responses-provider.js";

const TOOLS: ToolDefinition[] = [
  {
    name: "bash",
    description: "Run a shell command",
    input_schema: { type: "object", properties: {} },
  },
];

const USER_MESSAGE: Message[] = [
  { role: "user", content: [{ type: "text", text: "hi" }] },
];

/**
 * Stub the SDK client so we can capture the outgoing chat.completions.create
 * params without hitting the network.
 */
function stubChatProvider(): {
  provider: OpenAIChatCompletionsProvider;
  requests: Array<Record<string, unknown>>;
} {
  const provider = new OpenAIChatCompletionsProvider("test-key", "test-model");
  const requests: Array<Record<string, unknown>> = [];
  (provider as unknown as { client: unknown }).client = {
    chat: {
      completions: {
        create: async (params: Record<string, unknown>) => {
          requests.push(params);
          return {
            async *[Symbol.asyncIterator]() {
              yield {
                choices: [{ delta: {}, finish_reason: "stop" }],
                usage: { prompt_tokens: 1, completion_tokens: 1 },
              };
            },
          };
        },
      },
    },
  };
  return { provider, requests };
}

describe("mapNeutralToolChoice (chat-completions wire format)", () => {
  // Each neutral tool_choice variant maps to its OpenAI-compatible form.
  test("maps the Anthropic-shaped union to OpenAI's tool_choice values", () => {
    // GIVEN the neutral (Anthropic-shaped) tool_choice union
    // WHEN each variant is mapped to the chat-completions wire format
    // THEN it produces the OpenAI-compatible value
    expect(mapNeutralToolChoice({ type: "auto" })).toBe("auto");
    expect(mapNeutralToolChoice({ type: "any" })).toBe("required");
    expect(mapNeutralToolChoice({ type: "none" })).toBe("none");
    expect(mapNeutralToolChoice({ type: "tool", name: "bash" })).toEqual({
      type: "function",
      function: { name: "bash" },
    });
  });

  // Unmappable input yields undefined so the request omits tool_choice.
  test("returns undefined for absent or unrecognized values", () => {
    // GIVEN values that don't describe a valid tool_choice
    // WHEN they are mapped
    // THEN the mapper returns undefined (request falls back to the API default)
    expect(mapNeutralToolChoice(undefined)).toBeUndefined();
    expect(mapNeutralToolChoice(null)).toBeUndefined();
    expect(mapNeutralToolChoice("none")).toBeUndefined();
    expect(mapNeutralToolChoice({ type: "bogus" })).toBeUndefined();
    // AND a forced tool with no name can't be expressed
    expect(mapNeutralToolChoice({ type: "tool" })).toBeUndefined();
  });
});

describe("mapNeutralToolChoiceForResponses (Responses API wire format)", () => {
  // The Responses API named shape omits the chat-completions function wrapper.
  test("uses the un-nested named-function shape", () => {
    // GIVEN the neutral tool_choice union
    // WHEN mapped to the Responses API format
    // THEN string variants match and the named shape has no `function` wrapper
    expect(mapNeutralToolChoiceForResponses({ type: "auto" })).toBe("auto");
    expect(mapNeutralToolChoiceForResponses({ type: "any" })).toBe("required");
    expect(mapNeutralToolChoiceForResponses({ type: "none" })).toBe("none");
    expect(
      mapNeutralToolChoiceForResponses({ type: "tool", name: "bash" }),
    ).toEqual({ type: "function", name: "bash" });
    expect(mapNeutralToolChoiceForResponses({ type: "bogus" })).toBeUndefined();
  });
});

describe("OpenAIChatCompletionsProvider tool_choice wiring", () => {
  // A `{ type: "none" }` config forces a text-only answer on the wire.
  test("forwards config.tool_choice on the wire when tools are present", async () => {
    // GIVEN a provider with a stubbed SDK client
    const { provider, requests } = stubChatProvider();

    // WHEN sendMessage is called with tools and tool_choice `{ type: "none" }`
    await provider.sendMessage(USER_MESSAGE, {
      tools: TOOLS,
      config: { tool_choice: { type: "none" } },
    });

    // THEN the outgoing request carries `tool_choice: "none"`
    expect(requests).toHaveLength(1);
    expect(requests[0].tool_choice).toBe("none");
    expect(requests[0].tools).toBeDefined();
  });

  // A `{ type: "tool", name }` config forces that specific tool call.
  test("maps a forced tool choice to the named-function wire shape", async () => {
    // GIVEN a provider with a stubbed SDK client
    const { provider, requests } = stubChatProvider();

    // WHEN sendMessage is called with a forced tool choice
    await provider.sendMessage(USER_MESSAGE, {
      tools: TOOLS,
      config: { tool_choice: { type: "tool", name: "bash" } },
    });

    // THEN the request carries the OpenAI named-function shape
    expect(requests[0].tool_choice).toEqual({
      type: "function",
      function: { name: "bash" },
    });
  });

  // tool_choice is only meaningful alongside tools, so it is dropped.
  test("omits tool_choice when no tools are supplied", async () => {
    // GIVEN a provider with a stubbed SDK client
    const { provider, requests } = stubChatProvider();

    // WHEN sendMessage is called with a tool_choice but no tools
    await provider.sendMessage(USER_MESSAGE, {
      config: { tool_choice: { type: "none" } },
    });

    // THEN the request omits both tools and tool_choice
    expect(requests[0].tools).toBeUndefined();
    expect(requests[0].tool_choice).toBeUndefined();
  });
});
