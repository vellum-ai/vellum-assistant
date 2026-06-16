import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Meta, StoryObj } from "@storybook/react-vite";

import type { LLMCallSummary, LLMRequestLogEntry } from "@vellumai/assistant-api";

import { CacheBreakpointMapCard } from "./cache-breakpoint-map-card";

/**
 * Stories for {@link CacheBreakpointMapCard}, the cache-segment map in the
 * inspector's Prompt tab. Every story shares one realistic four-breakpoint
 * Anthropic request and varies only the reported read/created token split,
 * so the segmentation stays fixed while the classification (all created,
 * all read, partial, disabled) changes.
 *
 * The card fetches the raw request payload through `useLlmLogPayload`, so
 * each call's payload is seeded into the shared `QueryClient` (fresh, so no
 * fetch fires) before the stories render.
 */
const ASSISTANT_ID = "assistant-1";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
});

function marker(ttl: string) {
  return { type: "ephemeral", ttl };
}

function text(value: string, cacheControl?: { type: string; ttl: string }) {
  return {
    type: "text",
    text: value,
    ...(cacheControl ? { cache_control: cacheControl } : {}),
  };
}

const SYSTEM_PROMPT = `You are Vellum, a helpful assistant. Follow the user's
instructions carefully and use the available tools when they help you answer
accurately. Keep responses concise.`;

const toolDefinitions = [
  {
    name: "file_read",
    description: "Read a file from the workspace.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  {
    name: "file_write",
    description: "Write a file to the workspace.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" }, contents: { type: "string" } },
      required: ["path", "contents"],
    },
    cache_control: marker("1h"),
  },
];

function cachedRequest() {
  return {
    model: "claude-sonnet-4",
    tools: toolDefinitions,
    system: [text(SYSTEM_PROMPT, marker("1h"))],
    messages: [
      {
        role: "user",
        content: [text("Summarize the file at src/app.ts", marker("1h"))],
      },
      { role: "assistant", content: [text("Here is a summary of the file.")] },
      {
        role: "user",
        content: [text("Now explain the main function", marker("5m"))],
      },
    ],
  };
}

function disabledRequest() {
  return {
    model: "claude-sonnet-4",
    tools: toolDefinitions.map(({ cache_control: _cacheControl, ...rest }) => rest),
    system: [text(SYSTEM_PROMPT)],
    messages: [
      { role: "user", content: [text("Summarize the file at src/app.ts")] },
    ],
  };
}

function register(
  id: string,
  requestPayload: unknown,
  summary: Partial<LLMCallSummary>,
): LLMRequestLogEntry {
  queryClient.setQueryData(
    ["assistants", ASSISTANT_ID, "llm-request-logs", id, "payload"],
    { id, requestPayload, responsePayload: null },
  );
  return {
    id,
    createdAt: Date.now(),
    requestPayload: null,
    responsePayload: null,
    provider: "anthropic",
    summary: { provider: "anthropic", model: "claude-sonnet-4", ...summary },
  };
}

const fullMissEntry = register("call-full-miss", cachedRequest(), {
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 4200,
});

const healthyEntry = register("call-healthy", cachedRequest(), {
  cacheReadInputTokens: 4200,
  cacheCreationInputTokens: 0,
});

const partialEntry = register("call-partial", cachedRequest(), {
  cacheReadInputTokens: 3200,
  cacheCreationInputTokens: 1000,
});

const disabledEntry = register("call-disabled", disabledRequest(), {
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 4200,
});

const meta: Meta<typeof CacheBreakpointMapCard> = {
  title: "Chat/Inspector/CacheBreakpointMapCard",
  component: CacheBreakpointMapCard,
  parameters: {
    layout: "centered",
  },
  decorators: [
    (Story) => (
      <QueryClientProvider client={queryClient}>
        <div className="w-[440px]">
          <Story />
        </div>
      </QueryClientProvider>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof CacheBreakpointMapCard>;

/**
 * The reported symptom: every segment was re-created this turn, so the map
 * paints the whole prefix as created and surfaces the full-miss notice.
 */
export const FullCacheMiss: Story = {
  args: { assistantId: ASSISTANT_ID, entry: fullMissEntry },
};

/**
 * The ideal turn: the entire cached prefix was served from cache, so every
 * segment reads as a cache hit.
 */
export const HealthyReuse: Story = {
  args: { assistantId: ASSISTANT_ID, entry: healthyEntry },
};

/**
 * A realistic partial turn: the stable prefix is reused while the advancing
 * tail is re-created, so the split lands at a breakpoint boundary.
 */
export const PartialReuse: Story = {
  args: { assistantId: ASSISTANT_ID, entry: partialEntry },
};

/**
 * Caching disabled: the request carries no `cache_control` markers, so the
 * card explains that no breakpoints were set rather than drawing a map.
 */
export const CachingDisabled: Story = {
  args: { assistantId: ASSISTANT_ID, entry: disabledEntry },
};
