import type { Meta, StoryObj } from "@storybook/react-vite";

import type { LLMRequestLogEntry } from "@vellumai/assistant-api";

import { PromptTab } from "./prompt-tab";

/**
 * Stories for {@link PromptTab}. The tab pins a cache-health breakdown at the
 * top and renders each normalized request section as a collapsible card so a
 * reader can fold a long prompt away and skip to the cache analysis. These
 * stories build a realistic {@link LLMRequestLogEntry} — the same shape the
 * `/v1/conversations/llm-context` route returns — to verify the integrated
 * layout, the collapse-all affordance, and the tool-definitions breakdown.
 */
const meta: Meta<typeof PromptTab> = {
  title: "Chat/Inspector/PromptTab",
  component: PromptTab,
  parameters: {
    layout: "fullscreen",
  },
  decorators: [
    (Story) => (
      <div className="mx-auto w-[640px]">
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof PromptTab>;

const SYSTEM_PROMPT = `You are Vellum, a helpful assistant.

Follow the user's instructions carefully and use the available tools when
they help you answer accurately. Keep responses concise.`;

const MEMORY_SECTION = `## Working memory
- The user prefers TypeScript over JavaScript.
- Current project: inspector cache analysis.
- Timezone: UTC.`;

const USER_TURN = `Why is my prompt cache busting on every new turn? The
inspector says "Created 36,634, Read 0" almost every time.`;

const toolDefinitions = [
  {
    name: "file_read",
    description: "Read a file from the workspace.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Workspace path." },
        encoding: { type: "string", enum: ["text", "binary"] },
      },
      required: ["path"],
    },
  },
  {
    type: "web_search_20250305",
    name: "web_search",
    max_uses: 8,
  },
];

const fullMissEntry: LLMRequestLogEntry = {
  id: "call-cache-miss",
  createdAt: Date.now(),
  requestPayload: null,
  responsePayload: null,
  provider: "anthropic",
  summary: {
    provider: "anthropic",
    model: "claude-sonnet-4",
    cacheCreationInputTokens: 36634,
    cacheReadInputTokens: 0,
    inputTokens: 18,
    outputTokens: 240,
  },
  requestSections: [
    { kind: "system", label: "System prompt", text: SYSTEM_PROMPT },
    { kind: "system", label: "Memory", text: MEMORY_SECTION },
    { kind: "tool_definitions", label: "Available tools", data: toolDefinitions },
    { kind: "user", label: "User", role: "user", text: USER_TURN },
  ],
};

const healthyEntry: LLMRequestLogEntry = {
  id: "call-cache-healthy",
  createdAt: Date.now(),
  requestPayload: null,
  responsePayload: null,
  provider: "anthropic",
  summary: {
    provider: "anthropic",
    model: "claude-sonnet-4",
    cacheCreationInputTokens: 120,
    cacheReadInputTokens: 36500,
    inputTokens: 24,
    outputTokens: 180,
  },
  requestSections: [
    { kind: "system", label: "System prompt", text: SYSTEM_PROMPT },
    { kind: "tool_definitions", label: "Available tools", data: toolDefinitions },
    { kind: "user", label: "User", role: "user", text: USER_TURN },
  ],
};

/**
 * Anthropic full bust matching the reported symptom: the cache-health banner
 * warns of a full miss and every section starts expanded.
 */
export const FullCacheMiss: Story = {
  args: { entry: fullMissEntry },
};

/**
 * Healthy reuse: the banner reports a high hit rate above the same
 * collapsible prompt sections.
 */
export const HealthyReuse: Story = {
  args: { entry: healthyEntry },
};
