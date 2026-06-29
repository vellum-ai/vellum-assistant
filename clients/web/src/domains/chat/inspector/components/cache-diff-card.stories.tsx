import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Meta, StoryObj } from "@storybook/react-vite";

import type { LLMRequestLogEntry } from "@vellumai/assistant-api";

import { CacheDiffCard } from "./cache-diff-card";

/**
 * Stories for {@link CacheDiffCard}, the prompt-cache prefix comparison
 * rendered in the inspector's Prompt tab. Each story pairs a current call
 * with the previous turn's request so the card can name the first logical
 * block that diverged — the answer to "why did my cache bust this turn?".
 *
 * Both calls carry their `requestSections` inline, so the on-demand
 * previous-call fetch stays disabled; the wrapping `QueryClientProvider`
 * only satisfies the hook the card calls before its early returns.
 */
const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
});

const meta: Meta<typeof CacheDiffCard> = {
  title: "Chat/Inspector/CacheDiffCard",
  component: CacheDiffCard,
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
type Story = StoryObj<typeof CacheDiffCard>;

const SYSTEM_PROMPT = `You are Vellum, a helpful assistant.

Follow the user's instructions carefully and use the available tools when
they help you answer accurately. Keep responses concise.`;

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
];

function call(
  id: string,
  sections: LLMRequestLogEntry["requestSections"],
  model = "claude-sonnet-4",
): LLMRequestLogEntry {
  return {
    id,
    createdAt: Date.now(),
    requestPayload: null,
    responsePayload: null,
    provider: "anthropic",
    summary: { provider: "anthropic", model },
    requestSections: sections,
  };
}

const previousMemoryTurn = call("call-prev", [
  { kind: "system", label: "System prompt", text: SYSTEM_PROMPT },
  {
    kind: "system",
    label: "Memory",
    text: "## Working memory\n- Timezone: UTC\n- Project: inspector",
  },
  { kind: "tool_definitions", label: "Available tools", data: toolDefinitions },
  { kind: "message", label: "User", role: "user", text: "What changed?" },
]);

/**
 * The reported symptom: a volatile line inside the system prompt (here a
 * memory timestamp) changed since the previous turn, so the cached prefix
 * is re-created and the card surfaces the exact diverging lines.
 */
export const SystemPromptChanged: Story = {
  args: {
    assistantId: "assistant-1",
    previous: previousMemoryTurn,
    current: call("call-cur", [
      { kind: "system", label: "System prompt", text: SYSTEM_PROMPT },
      {
        kind: "system",
        label: "Memory",
        text: "## Working memory\n- Timezone: UTC\n- Project: inspector\n- Last updated: 14:32",
      },
      {
        kind: "tool_definitions",
        label: "Available tools",
        data: toolDefinitions,
      },
      { kind: "message", label: "User", role: "user", text: "What changed?" },
    ]),
  },
};

/**
 * Switching models can't reuse the previous turn's cache at all, so the
 * card reports the model change as the dominant cause.
 */
export const ModelChanged: Story = {
  args: {
    assistantId: "assistant-1",
    previous: call(
      "call-prev",
      [{ kind: "system", label: "System prompt", text: SYSTEM_PROMPT }],
      "claude-3-7-sonnet",
    ),
    current: call(
      "call-cur",
      [{ kind: "system", label: "System prompt", text: SYSTEM_PROMPT }],
      "claude-sonnet-4",
    ),
  },
};

/**
 * An earlier message diverged from the previous turn, so everything cached
 * after it is re-processed; the card points at the offending message.
 */
export const MessageChanged: Story = {
  args: {
    assistantId: "assistant-1",
    previous: call("call-prev", [
      { kind: "system", label: "System prompt", text: SYSTEM_PROMPT },
      { kind: "message", label: "User", role: "user", text: "Summarize the file at src/app.ts" },
      { kind: "message", label: "Assistant", role: "assistant", text: "Done." },
    ]),
    current: call("call-cur", [
      { kind: "system", label: "System prompt", text: SYSTEM_PROMPT },
      { kind: "message", label: "User", role: "user", text: "Summarize the file at src/main.ts" },
      { kind: "message", label: "Assistant", role: "assistant", text: "Done." },
    ]),
  },
};

/**
 * Healthy turn: the cached prefix is identical and only a new message was
 * appended, so a miss here points to cache TTL expiry rather than changed
 * content.
 */
export const UnchangedPrefix: Story = {
  args: {
    assistantId: "assistant-1",
    previous: call("call-prev", [
      { kind: "system", label: "System prompt", text: SYSTEM_PROMPT },
      { kind: "message", label: "User", role: "user", text: "First question" },
    ]),
    current: call("call-cur", [
      { kind: "system", label: "System prompt", text: SYSTEM_PROMPT },
      { kind: "message", label: "User", role: "user", text: "First question" },
      { kind: "message", label: "Assistant", role: "assistant", text: "Answer" },
      { kind: "message", label: "User", role: "user", text: "Follow-up question" },
    ]),
  },
};

const scatteredPrompt = (variant: string): string =>
  Array.from({ length: 200 }, (_, i) =>
    i % 4 === 0 ? `- rule ${variant} ${i}: be precise` : `  note line ${i}`,
  ).join("\n");

/**
 * Many scattered single-line changes overflow the in-panel display cap, so
 * the diff shows the first hunks and offers a "Show N more diff line(s)"
 * toggle to reveal the rest inline.
 */
export const LargeScatteredDiff: Story = {
  args: {
    assistantId: "assistant-1",
    previous: call("call-prev", [
      { kind: "system", label: "System prompt", text: scatteredPrompt("A") },
      { kind: "message", label: "User", role: "user", text: "What changed?" },
    ]),
    current: call("call-cur", [
      { kind: "system", label: "System prompt", text: scatteredPrompt("B") },
      { kind: "message", label: "User", role: "user", text: "What changed?" },
    ]),
  },
};

const HUGE_PROMPT = Array.from(
  { length: 600 },
  (_, i) => `Policy ${i}: follow the rules carefully.`,
).join("\n");

/**
 * A system prompt over the eager line cap isn't diffed on the default
 * render; the card explains why and offers a "Diff anyway" button that
 * computes the full diff on demand.
 */
export const TooLargeToDiff: Story = {
  args: {
    assistantId: "assistant-1",
    previous: call("call-prev", [
      { kind: "system", label: "System prompt", text: HUGE_PROMPT },
      { kind: "message", label: "User", role: "user", text: "What changed?" },
    ]),
    current: call("call-cur", [
      {
        kind: "system",
        label: "System prompt",
        text: `${HUGE_PROMPT}\nPolicy 600: and one additional rule.`,
      },
      { kind: "message", label: "User", role: "user", text: "What changed?" },
    ]),
  },
};
