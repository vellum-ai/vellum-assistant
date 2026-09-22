import type { Meta, StoryObj } from "@storybook/react-vite";

import { WebFetchCard } from "@/domains/settings/ai/web-fetch-card";
import { withQueryCache } from "@/lib/story-query-cache";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";

const meta: Meta<typeof WebFetchCard> = {
  title: "Settings/AI/WebFetchCard",
  component: WebFetchCard,
  decorators: [
    (Story) => {
      // The card reads the active assistant id from the resolved-assistants
      // store; seed it so `useActiveAssistantId()` doesn't throw.
      useResolvedAssistantsStore.setState({
        activeAssistantId: "story-assistant",
      });
      return (
        <div style={{ maxWidth: 640, padding: 24 }}>
          <Story />
        </div>
      );
    },
    // No network in Storybook, and the cache never retries, so the config
    // query falls back to localStorage defaults (provider = "default")
    // instead of spinning.
    withQueryCache(),
  ],
};

export default meta;
type Story = StoryObj<typeof WebFetchCard>;

/**
 * Default state: provider picker defaults to the built-in fetcher. Selecting
 * "Firecrawl" reveals the API-key input (BYOK).
 */
export const Default: Story = {};
