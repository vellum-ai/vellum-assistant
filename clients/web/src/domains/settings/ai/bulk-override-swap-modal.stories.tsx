import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Meta, StoryObj } from "@storybook/react-vite";

import { BulkOverrideSwapModal } from "@/domains/settings/ai/bulk-override-swap-modal";

const ASSISTANT_ID = "story-assistant";

const DOMAINS = [
  { id: "agentLoop", displayName: "Agent Loop" },
  { id: "background", displayName: "Background" },
];

const CALL_SITES = [
  {
    id: "subagentSpawn",
    displayName: "Subagent Spawn",
    description: "Spawns a subagent to handle a delegated subtask.",
    domain: "agentLoop",
    defaultProfile: "balanced",
  },
  {
    // Profileless call site: no resolver-winning default, but the catalog
    // reports the shipped Balanced tier, matching its panel caption.
    id: "workflowLeaf",
    displayName: "Workflow Leaf",
    description: "Runs an ephemeral leaf agent.",
    domain: "agentLoop",
    shippedDefaultProfile: "balanced",
  },
  {
    id: "conversationCompaction",
    displayName: "Conversation Compaction",
    description: "Summarizes long context before continuing a turn.",
    domain: "background",
    defaultProfile: "balanced",
  },
  {
    id: "heartbeatAgent",
    displayName: "Heartbeat Agent",
    description: "Runs background tasks and proactive checks on a schedule.",
    domain: "background",
    defaultProfile: "cost-optimized",
  },
  {
    id: "conversationTitle",
    displayName: "Conversation Title",
    description: "Creates a short title after the first useful turn.",
    domain: "background",
    defaultProfile: "balanced",
  },
];

const PROFILES = [
  { name: "balanced", label: "Balanced", status: "active" as const },
  { name: "cost-optimized", label: "Cost", status: "active" as const },
  { name: "speed-tier", label: "Speed", status: "active" as const },
  { name: "quality-optimized", label: "Quality", status: "active" as const },
];

const meta: Meta<typeof BulkOverrideSwapModal> = {
  title: "Settings/AI/BulkOverrideSwapModal",
  component: BulkOverrideSwapModal,
  args: {
    assistantId: ASSISTANT_ID,
    callSites: CALL_SITES,
    domains: DOMAINS,
    orderedProfiles: PROFILES,
    onClose: () => {},
    onApplied: () => {},
  },
  decorators: [
    (Story) => (
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <Story />
      </QueryClientProvider>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof BulkOverrideSwapModal>;

/**
 * Balanced is used three ways at once: Subagent Spawn through its default,
 * Conversation Title through an explicit override, and Workflow Leaf as a
 * profileless site the catalog reports under the shipped Balanced tier.
 * The source dropdown also offers Cost (Heartbeat Agent's default).
 * Conversation Compaction carries a model pin ("Custom" in the editor) and
 * stays out of the list even though its default names Balanced.
 */
export const OverridesAndDefaults: Story = {
  args: {
    persistedOverrides: {
      conversationTitle: { profile: "balanced" },
      conversationCompaction: { profile: "balanced", model: "glm-5.2" },
    },
  },
};

/** A single affected action: singular copy throughout. */
export const SingleAffected: Story = {
  args: {
    callSites: CALL_SITES.filter((cs) => cs.id === "heartbeatAgent"),
    persistedOverrides: {},
  },
};
