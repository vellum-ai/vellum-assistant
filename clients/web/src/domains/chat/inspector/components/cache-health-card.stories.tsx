import type { Meta, StoryObj } from "@storybook/react-vite";

import type { LLMCallSummary } from "@vellumai/assistant-api";

import { CacheHealthCard } from "./cache-health-card";

/**
 * Stories for {@link CacheHealthCard}, the prompt-cache breakdown pinned at
 * the top of the inspector's Prompt tab. Each story exercises one of the
 * provider-aware status bands the card renders from `entry.summary`:
 * full miss, partial reuse, healthy reuse, and the no-cache-data fallback.
 */
const meta: Meta<typeof CacheHealthCard> = {
  title: "Chat/Inspector/CacheHealthCard",
  component: CacheHealthCard,
  parameters: {
    layout: "centered",
  },
  decorators: [
    (Story) => (
      <div className="w-[440px]">
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof CacheHealthCard>;

function summary(overrides: Partial<LLMCallSummary>): LLMCallSummary {
  return { provider: "anthropic", model: "claude-sonnet-4", ...overrides };
}

/**
 * Anthropic full bust: a large cached prefix was written this turn but none
 * of it was read back, so the bar is entirely "re-created" and the banner
 * warns that the cached prefix likely changed since the previous turn.
 */
export const FullCacheMiss: Story = {
  args: {
    summary: summary({
      cacheCreationInputTokens: 36634,
      cacheReadInputTokens: 0,
      inputTokens: 18,
    }),
  },
};

/**
 * Anthropic healthy reuse: almost the entire prompt was served from cache.
 */
export const HealthyReuse: Story = {
  args: {
    summary: summary({
      cacheCreationInputTokens: 120,
      cacheReadInputTokens: 36500,
      inputTokens: 24,
    }),
  },
};

/**
 * OpenAI partial reuse: `inputTokens` already includes the cached subset, so
 * the card treats `cacheReadInputTokens` as a portion of the input rather
 * than a separate segment.
 */
export const PartialReuseOpenAi: Story = {
  args: {
    summary: summary({
      provider: "openai",
      model: "gpt-4.1",
      cacheReadInputTokens: 600,
      inputTokens: 1000,
    }),
  },
};

/**
 * Provider reported no cache fields (e.g. Gemini): the card collapses to a
 * compact "didn't report prompt-cache usage" note instead of a bar.
 */
export const Unavailable: Story = {
  args: {
    summary: summary({
      provider: "gemini",
      model: "gemini-2.5-pro",
      inputTokens: 1000,
    }),
  },
};
