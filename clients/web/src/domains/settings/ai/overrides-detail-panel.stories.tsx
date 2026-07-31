import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Meta, StoryObj } from "@storybook/react-vite";

import {
  configGetOptions,
  configLlmCallsitesGetOptions,
} from "@/generated/daemon/@tanstack/react-query.gen";
import type {
  ConfigGetResponse,
  ConfigLlmCallsitesGetResponse,
} from "@/generated/daemon/types.gen";
import { OverridesDetailPanel } from "@/domains/settings/ai/overrides-detail-panel";

const ASSISTANT_ID = "story-assistant";

// Both queries are seeded directly into the cache. Storybook has no daemon,
// and an unresolved config query renders the panel's loading state instead of
// the thing this story documents.
const CATALOG: ConfigLlmCallsitesGetResponse = {
  domains: [{ id: "agentLoop", displayName: "Agent Loop" }],
  callSites: [
    {
      // Filtered out by the panel: the chat model is picked via the profile
      // picker, not here. Present so the story proves it stays hidden.
      id: "mainAgent",
      displayName: "Main Agent",
      description: "The primary conversation agent that handles user messages.",
      domain: "agentLoop",
    },
    {
      id: "subagentSpawn",
      displayName: "Subagent Spawn",
      description: "Spawns a subagent to handle a delegated subtask.",
      domain: "agentLoop",
      defaultProfile: "balanced",
    },
    {
      id: "heartbeatAgent",
      displayName: "Heartbeat Agent",
      description: "Runs background tasks and proactive checks on a schedule.",
      domain: "agentLoop",
      defaultProfile: "speed-tier",
    },
  ],
};

// The three managed defaults a stock install ships with, hence
// `provider: "vellum"` on each.
const CONFIG: ConfigGetResponse = {
  llm: {
    profiles: {
      "quality-optimized": {
        label: "Quality",
        provider: "vellum",
        model: "gpt-5.6-sol",
        source: "managed",
        status: "active",
      },
      balanced: {
        label: "Balanced",
        provider: "vellum",
        model: "glm-5.2",
        source: "managed",
        status: "active",
      },
      "speed-tier": {
        label: "Speed",
        provider: "vellum",
        model: "deepseek-v4-flash",
        source: "managed",
        status: "active",
      },
    },
    profileOrder: ["quality-optimized", "balanced", "speed-tier"],
    activeProfile: "balanced",
    advisorProfile: "quality-optimized",
    callSites: {},
  },
};

// Seed through the generated options factories rather than a hand-written
// key. HeyAPI bakes the path params into the query key, so a literal
// `[{ _id: "configGet" }]` misses and the panel renders its error state.
function seededClient() {
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        refetchOnWindowFocus: false,
        staleTime: Infinity,
      },
    },
  });
  const path = { assistant_id: ASSISTANT_ID };
  client.setQueryData(configLlmCallsitesGetOptions({ path }).queryKey, CATALOG);
  client.setQueryData(configGetOptions({ path }).queryKey, CONFIG);
  return client;
}

const meta: Meta<typeof OverridesDetailPanel> = {
  title: "Settings/AI/OverridesDetailPanel",
  component: OverridesDetailPanel,
  args: { assistantId: ASSISTANT_ID, onClose: () => {} },
  decorators: [
    (Story) => (
      <QueryClientProvider client={seededClient()}>
        <div style={{ maxWidth: 560, height: 720 }}>
          <Story />
        </div>
      </QueryClientProvider>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof OverridesDetailPanel>;

/**
 * The Advisor setting sits above the call-site groups: a top-level
 * `llm.advisorProfile` selection that rides this panel's Save button but
 * never enters the `llm.callSites` patch.
 */
export const Default: Story = {};
