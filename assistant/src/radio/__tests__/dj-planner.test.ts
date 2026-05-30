import { beforeEach, describe, expect, mock, test } from "bun:test";

import type {
  ContentBlock,
  Message,
  Provider,
  ProviderResponse,
  SendMessageOptions,
  ToolDefinition,
} from "../../providers/types.js";
import type { ToolContext, ToolExecutionResult } from "../../tools/types.js";
import type { RadioTrack } from "../types.js";

const trackCandidates: readonly RadioTrack[] = [
  {
    id: "soft-launch",
    title: "Soft Launch",
    artist: "Vellum Demo Ensemble",
    durationMs: 18_000,
    assetPath: "/tmp/soft-launch.wav",
    audioPath: "radio/tracks/soft-launch",
    sourceLabel: "Generated demo track",
    license: "repo-generated",
    sha256: "sha-1",
  },
  {
    id: "buffer-bloom",
    title: "Buffer Bloom",
    artist: "Vellum Demo Ensemble",
    durationMs: 18_000,
    assetPath: "/tmp/buffer-bloom.wav",
    audioPath: "radio/tracks/buffer-bloom",
    sourceLabel: "Generated demo track",
    license: "repo-generated",
    sha256: "sha-2",
  },
];

const webSearchDefinition: ToolDefinition = {
  name: "web_search",
  description: "Search the web",
  input_schema: {
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"],
  },
};

const webFetchDefinition: ToolDefinition = {
  name: "web_fetch",
  description: "Fetch a webpage",
  input_schema: {
    type: "object",
    properties: {
      url: { type: "string" },
      allow_private_network: { type: "boolean" },
    },
    required: ["url"],
  },
};

let configuredProviderCallSites: string[] = [];
type MockProvider = Provider & {
  sendMessage: ReturnType<typeof mock>;
};

let currentProvider: MockProvider | null = null;
let webSearchExecuteCalls: Array<{
  input: Record<string, unknown>;
  context: ToolContext;
}> = [];
let webFetchExecuteCalls: Array<{
  input: Record<string, unknown>;
  context: ToolContext;
}> = [];

const getConfiguredProviderMock = mock(async (callSite: string) => {
  configuredProviderCallSites.push(callSite);
  return currentProvider;
});

const webSearchExecuteMock = mock(
  async (
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolExecutionResult> => {
    webSearchExecuteCalls.push({ input, context });
    return {
      content: "Search result: Phoenix has a playoff game tonight.",
      isError: false,
    };
  },
);

const webFetchExecuteMock = mock(
  async (
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolExecutionResult> => {
    webFetchExecuteCalls.push({ input, context });
    return { content: "Fetched page content.", isError: false };
  },
);

mock.module("../../providers/provider-send-message.js", () => ({
  getConfiguredProvider: getConfiguredProviderMock,
}));

mock.module("../../tools/network/web-search.js", () => ({
  webSearchTool: {
    ...webSearchDefinition,
    execute: webSearchExecuteMock,
  },
}));

mock.module("../../tools/network/web-fetch.js", () => ({
  webFetchTool: {
    ...webFetchDefinition,
    execute: webFetchExecuteMock,
  },
}));

mock.module("../../util/platform.js", () => ({
  getWorkspaceDir: () => "/tmp/vellum-workspace",
}));

const { planRadioDjBreak, RadioDjPlannerError } =
  await import("../dj-planner.js");

function providerResponse(content: ContentBlock[]): ProviderResponse {
  return {
    content,
    model: "test-model",
    usage: { inputTokens: 1, outputTokens: 1 },
    stopReason: "end_turn",
  };
}

function makeProvider(responses: ProviderResponse[]): MockProvider {
  const sendMessage = mock(
    async (
      _messages: Message[],
      _tools?: ToolDefinition[],
      _systemPrompt?: string,
      _options?: SendMessageOptions,
    ): Promise<ProviderResponse> => {
      const response = responses.shift();
      if (!response) throw new Error("unexpected provider call");
      return response;
    },
  );

  return { name: "mock-provider", sendMessage } as Provider & {
    sendMessage: typeof sendMessage;
  };
}

function inputSchemaProperties(tool: ToolDefinition): Record<string, unknown> {
  return (
    (tool.input_schema as { properties?: Record<string, unknown> })
      .properties ?? {}
  );
}

function baseParams(signal?: AbortSignal) {
  return {
    reason: "song_ended" as const,
    currentTrackId: "soft-launch",
    recentTrackIds: ["soft-launch"],
    trackCandidates,
    signal,
  };
}

describe("planRadioDjBreak", () => {
  beforeEach(() => {
    configuredProviderCallSites = [];
    webSearchExecuteCalls = [];
    webFetchExecuteCalls = [];
    getConfiguredProviderMock.mockClear();
    webSearchExecuteMock.mockClear();
    webFetchExecuteMock.mockClear();
    currentProvider = null;
  });

  test("calls the radioDj provider callsite and parses a valid JSON response", async () => {
    currentProvider = makeProvider([
      providerResponse([
        {
          type: "text",
          text: JSON.stringify({
            nextTrackId: "buffer-bloom",
            djText: "Tiny weather in the wires, then Buffer Bloom rolls in.",
          }),
        },
      ]),
    ]);

    const result = await planRadioDjBreak(baseParams());

    expect(configuredProviderCallSites).toEqual(["radioDj"]);
    expect(result.nextTrackId).toBe("buffer-bloom");
    expect(result.nextTrack.id).toBe("buffer-bloom");
    expect(result.djText).toBe(
      "Tiny weather in the wires, then Buffer Bloom rolls in.",
    );

    const [, tools, systemPrompt, options] = currentProvider.sendMessage.mock
      .calls[0] as Parameters<Provider["sendMessage"]>;
    expect(tools?.map((tool) => tool.name)).toEqual([
      "web_search",
      "web_fetch",
    ]);
    expect(systemPrompt).toContain("return JSON only");
    expect(options?.config?.callSite).toBe("radioDj");
  });

  test("rejects a model-selected track id that was not provided", async () => {
    currentProvider = makeProvider([
      providerResponse([
        {
          type: "text",
          text: JSON.stringify({
            nextTrackId: "not-in-the-catalog",
            djText: "This should not make it to playback.",
          }),
        },
      ]),
    ]);

    await expect(planRadioDjBreak(baseParams())).rejects.toMatchObject({
      name: "RadioDjPlannerError",
      code: "invalid_track_id",
    });
  });

  test("uses a typed error path for malformed JSON", async () => {
    currentProvider = makeProvider([
      providerResponse([{ type: "text", text: "buffer-bloom is next!" }]),
    ]);

    try {
      await planRadioDjBreak(baseParams());
      throw new Error("Expected malformed JSON to be rejected");
    } catch (error) {
      expect(error).toBeInstanceOf(RadioDjPlannerError);
      expect(error).toMatchObject({ code: "malformed_response" });
    }
  });

  test("executes normal web_search tool_use blocks and feeds tool results into the next provider call", async () => {
    const controller = new AbortController();
    const firstResponseContent: ContentBlock[] = [
      {
        type: "text",
        text: "I should stay in the transcript before the tool call.",
      },
      {
        type: "server_tool_use",
        id: "srv_search",
        name: "web_search",
        input: { query: "server side search" },
      },
      {
        type: "web_search_tool_result",
        tool_use_id: "srv_search",
        content: { status: "ok", encrypted_content: "opaque" },
      },
      {
        type: "tool_use",
        id: "toolu_search",
        name: "web_search",
        input: { query: "Phoenix sports tonight", count: 3 },
      },
    ];
    currentProvider = makeProvider([
      providerResponse(firstResponseContent),
      providerResponse([
        {
          type: "text",
          text: JSON.stringify({
            nextTrackId: "buffer-bloom",
            djText: "A quick Phoenix scoreboard glow, then Buffer Bloom.",
          }),
        },
      ]),
    ]);

    const result = await planRadioDjBreak(baseParams(controller.signal));

    expect(result.nextTrackId).toBe("buffer-bloom");
    expect(webSearchExecuteCalls).toHaveLength(1);
    expect(webSearchExecuteCalls[0]!.input).toEqual({
      query: "Phoenix sports tonight",
      count: 3,
    });
    expect(webSearchExecuteCalls[0]!.context).toMatchObject({
      conversationId: "radio",
      workingDir: "/tmp/vellum-workspace",
      trustClass: "guardian",
      executionChannel: "vellum",
      signal: controller.signal,
    });
    expect(webSearchExecuteCalls[0]!.context.requestId).toStartWith(
      "radio-dj-",
    );
    expect(
      [...webSearchExecuteCalls[0]!.context.allowedToolNames!].sort(),
    ).toEqual(["web_fetch", "web_search"]);

    const secondCall = currentProvider.sendMessage.mock.calls[1] as Parameters<
      Provider["sendMessage"]
    >;
    expect(secondCall[0].slice(-2)).toEqual([
      {
        role: "assistant",
        content: firstResponseContent,
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_search",
            content: "Search result: Phoenix has a playoff game tonight.",
          },
        ],
      },
    ]);
  });

  test("removes private-network web_fetch access and rejects attempts before execution", async () => {
    currentProvider = makeProvider([
      providerResponse([
        {
          type: "tool_use",
          id: "toolu_fetch",
          name: "web_fetch",
          input: {
            url: "http://127.0.0.1:7821/metadata",
            allow_private_network: true,
          },
        },
      ]),
      providerResponse([
        {
          type: "text",
          text: JSON.stringify({
            nextTrackId: "buffer-bloom",
            djText: "No private detours, just the next tune.",
          }),
        },
      ]),
    ]);

    const result = await planRadioDjBreak(baseParams());

    expect(result.nextTrackId).toBe("buffer-bloom");
    expect(webFetchExecuteCalls).toHaveLength(0);

    const firstCall = currentProvider.sendMessage.mock.calls[0] as Parameters<
      Provider["sendMessage"]
    >;
    const djFacingFetchDefinition = firstCall[1]!.find(
      (tool) => tool.name === "web_fetch",
    )!;
    expect(
      Object.keys(inputSchemaProperties(djFacingFetchDefinition)),
    ).not.toContain("allow_private_network");
    expect(Object.keys(inputSchemaProperties(webFetchDefinition))).toContain(
      "allow_private_network",
    );

    const secondCall = currentProvider.sendMessage.mock.calls[1] as Parameters<
      Provider["sendMessage"]
    >;
    expect(secondCall[0].at(-1)).toEqual({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_fetch",
          content:
            "web_fetch allow_private_network is not available to the radio DJ.",
          is_error: true,
        },
      ],
    });
  });

  test("returns unexpected tool names as error tool results without executing them", async () => {
    currentProvider = makeProvider([
      providerResponse([
        {
          type: "tool_use",
          id: "toolu_shell",
          name: "bash",
          input: { command: "say nope" },
        },
      ]),
      providerResponse([
        {
          type: "text",
          text: JSON.stringify({
            nextTrackId: "buffer-bloom",
            djText: "Back to the music, no detours.",
          }),
        },
      ]),
    ]);

    const result = await planRadioDjBreak(baseParams());

    expect(result.nextTrackId).toBe("buffer-bloom");
    expect(webSearchExecuteCalls).toHaveLength(0);
    expect(webFetchExecuteCalls).toHaveLength(0);

    const secondCall = currentProvider.sendMessage.mock.calls[1] as Parameters<
      Provider["sendMessage"]
    >;
    expect(secondCall[0].at(-1)).toEqual({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_shell",
          content:
            'Tool "bash" is not available to the radio DJ. Allowed tools: web_search, web_fetch.',
          is_error: true,
        },
      ],
    });
  });
});
