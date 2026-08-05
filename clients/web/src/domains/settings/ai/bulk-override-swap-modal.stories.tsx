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
  },
  {
    id: "workflowLeaf",
    displayName: "Workflow Leaf",
    description: "Runs an ephemeral leaf agent.",
    domain: "agentLoop",
  },
  {
    id: "heartbeatAgent",
    displayName: "Heartbeat Agent",
    description: "Runs background tasks and proactive checks on a schedule.",
    domain: "background",
  },
  {
    id: "conversationTitle",
    displayName: "Conversation Title",
    description: "Creates a short title after the first useful turn.",
    domain: "background",
  },
];

const PROFILES = [
  { name: "balanced", label: "Balanced", status: "active" as const },
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
 * Several overrides reference Balanced, so the modal opens with Balanced as
 * the source and every affected action selected. The Conversation Title row
 * carries a model pin ("Custom" in the editor) and stays out of the list
 * even though it also names Balanced.
 */
export const SeveralAffected: Story = {
  args: {
    persistedOverrides: {
      subagentSpawn: { profile: "balanced" },
      workflowLeaf: { profile: "balanced" },
      heartbeatAgent: { profile: "speed-tier" },
      conversationTitle: { profile: "balanced", model: "glm-5.2" },
    },
  },
};

/** A single affected override: singular copy throughout. */
export const SingleAffected: Story = {
  args: {
    persistedOverrides: {
      heartbeatAgent: { profile: "speed-tier" },
    },
  },
};
