import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
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
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";

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
function seededClient(config: ConfigGetResponse) {
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
  client.setQueryData(configGetOptions({ path }).queryKey, config);
  return client;
}

/** Wraps a story in a provider seeded with `config`. */
function withConfig(config: ConfigGetResponse) {
  return function ConfigDecorator(Story: () => ReactNode) {
    return (
      <QueryClientProvider client={seededClient(config)}>
        <div style={{ maxWidth: 560, height: 720 }}>
          <Story />
        </div>
      </QueryClientProvider>
    );
  };
}

/**
 * Pins the assistant version the `complete-profile-snapshots` gate reads,
 * and restores it afterwards.
 *
 * The identity store is a module singleton, so a story that leaves a version
 * behind changes how later stories resolve. Seeding in `beforeEach` rather
 * than during decorator render also keeps the write out of the render pass,
 * where two mounted variants would race and the last one would win.
 */
function withAssistantVersion(version: string) {
  return () => {
    const previous = useAssistantIdentityStore.getState().version;
    useAssistantIdentityStore.setState({ version });
    return () => {
      useAssistantIdentityStore.setState({ version: previous });
    };
  };
}

const meta: Meta<typeof OverridesDetailPanel> = {
  title: "Settings/AI/OverridesDetailPanel",
  component: OverridesDetailPanel,
  args: { assistantId: ASSISTANT_ID, onClose: () => {} },
  decorators: [withConfig(CONFIG)],
};

export default meta;
type Story = StoryObj<typeof OverridesDetailPanel>;

/**
 * The Advisor setting sits above the call-site groups: a top-level
 * `llm.advisorProfile` selection that rides this panel's Save button but
 * never enters the `llm.callSites` patch.
 */
export const Default: Story = {};

// A config carrying every state the picker has to judge. Only the two
// healthy profiles and the sound mix are dispatchable; the rest are what the
// resolver would skip.
const MIXED_HEALTH_CONFIG: ConfigGetResponse = {
  llm: {
    profiles: {
      balanced: {
        label: "Balanced",
        provider: "vellum",
        model: "glm-5.2",
        source: "managed",
        status: "active",
      },
      "quality-optimized": {
        label: "Quality",
        provider: "vellum",
        model: "gpt-5.6-sol",
        source: "managed",
        status: "active",
      },
      // Names a provider but no model, so the resolver reports the rung as
      // "incomplete" and falls through.
      "half-made": { label: "Half Made", provider: "anthropic" },
      retired: {
        label: "Retired",
        provider: "vellum",
        model: "glm-5.2",
        status: "disabled",
      },
      // Every arm dispatches, so the mix is offered.
      "sound-mix": {
        label: "Sound Mix",
        mix: [
          { profile: "balanced", weight: 1 },
          { profile: "quality-optimized", weight: 1 },
        ],
      },
      // One arm cannot dispatch. The arm is picked per conversation, so this
      // would work on some turns and silently fall through on others.
      "flaky-mix": {
        label: "Flaky Mix",
        mix: [
          { profile: "balanced", weight: 1 },
          { profile: "half-made", weight: 1 },
        ],
      },
    },
    profileOrder: [
      "balanced",
      "quality-optimized",
      "half-made",
      "retired",
      "sound-mix",
      "flaky-mix",
    ],
    activeProfile: "balanced",
    // Deliberately pointing at a profile that cannot dispatch, to show the
    // carve-out: the current selection is never hidden, or the trigger would
    // render blank with no way out.
    advisorProfile: "half-made",
    callSites: {},
  },
};

/**
 * What the pickers hide and what they keep.
 *
 * Open the Advisor dropdown, or toggle a call-site row on and open its
 * dropdown: only Balanced, Quality, and Sound Mix are offered. Half Made
 * (no model), Retired (disabled), and Flaky Mix (one arm with no model) are
 * all absent, because the resolver would skip each of them and run something
 * else while the picker showed your choice.
 *
 * The Advisor is set to Half Made, so it renders as the current selection
 * labeled "(Unavailable)": the one entry that stays visible whatever its
 * state, so the trigger has a label and there is a way back.
 */
export const UndispatchableProfilesHidden: Story = {
  // Kept off the autodocs page: it and the legacy variant below need
  // different assistant versions, and autodocs mounts every story in this
  // file into one preview where the identity singleton cannot hold both.
  tags: ["!autodocs"],
  beforeEach: withAssistantVersion("0.10.8"),
  decorators: [withConfig(MIXED_HEALTH_CONFIG)],
};

/**
 * The same config against an assistant older than 0.10.8.
 *
 * Those assistants deep-merge at resolution time, so a blank provider or
 * model live-inherits and Half Made dispatches fine. Nothing is hidden and
 * nothing is flagged: only Retired is missing, because disabled is a choice
 * the user made rather than an inherited blank. Flaky Mix is offered too,
 * since its sparse arm is valid there.
 */
export const LegacyAssistantKeepsSparseProfiles: Story = {
  tags: ["!autodocs"],
  beforeEach: withAssistantVersion("0.10.7"),
  decorators: [withConfig(MIXED_HEALTH_CONFIG)],
};
