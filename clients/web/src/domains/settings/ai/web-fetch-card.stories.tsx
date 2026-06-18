import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Meta, StoryObj } from "@storybook/react-vite";

import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { WebFetchCard } from "@/domains/settings/ai/web-fetch-card";

// No network in Storybook — disable retries so the config query falls back to
// localStorage defaults (provider = "default") instead of spinning.
const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: false, refetchOnWindowFocus: false, staleTime: Infinity },
  },
});

const meta: Meta<typeof WebFetchCard> = {
  title: "Settings/AI/WebFetchCard",
  component: WebFetchCard,
  decorators: [
    (Story) => {
      // The card reads the active assistant id from the resolved-assistants
      // store; seed it so `useActiveAssistantId()` doesn't throw.
      useResolvedAssistantsStore.setState({ activeAssistantId: "story-assistant" });
      return (
        <QueryClientProvider client={queryClient}>
          <div style={{ maxWidth: 640, padding: 24 }}>
            <Story />
          </div>
        </QueryClientProvider>
      );
    },
  ],
};

export default meta;
type Story = StoryObj<typeof WebFetchCard>;

/**
 * Default state: provider picker defaults to the built-in fetcher. Selecting
 * "Firecrawl" reveals the API-key input (BYOK).
 */
export const Default: Story = {};
