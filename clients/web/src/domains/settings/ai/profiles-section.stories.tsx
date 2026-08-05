import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Meta, StoryObj } from "@storybook/react-vite";

import { ProfilesSection } from "@/domains/settings/ai/profiles-section";
import {
  configGetOptions,
  inferenceProfilesGetOptions,
} from "@/generated/daemon/@tanstack/react-query.gen";
import type {
  ConfigGetResponse,
  InferenceProfileSummary,
} from "@/generated/daemon/types.gen";

const ASSISTANT_ID = "story-assistant";

function summary(
  over: Partial<InferenceProfileSummary> & { name: string },
): InferenceProfileSummary {
  return {
    label: null,
    provider: "anthropic",
    model: "claude-opus-5",
    status: "active",
    source: "user",
    availability: { status: "ok" },
    ...over,
  };
}

// The list as the settings page renders it: a managed default, a healthy
// custom profile, one the user switched off, one whose credential is gone,
// and one that was never finished.
const PROFILES: InferenceProfileSummary[] = [
  summary({
    name: "balanced",
    label: "Balanced",
    provider: "vellum",
    model: "glm-5.2",
    source: "managed",
  }),
  summary({ name: "my-custom", label: "My Custom" }),
  summary({ name: "retired", label: "Retired", status: "disabled" }),
  summary({
    name: "byok",
    label: "My OpenAI",
    provider: "openai",
    model: "gpt-5.5",
    availability: {
      status: "missing_credential",
      message:
        'Connection "openai-personal" has no stored API key. Add one in Settings, Models & Services.',
    },
  }),
  summary({
    name: "half-made",
    label: "Half Made",
    model: null,
    availability: {
      status: "incomplete",
      message:
        "Missing a model, so actions using it fall back to another profile.",
    },
  }),
];

const CONFIG: ConfigGetResponse = {
  llm: {
    profiles: {
      balanced: { label: "Balanced", provider: "vellum", model: "glm-5.2" },
      "my-custom": {
        label: "My Custom",
        provider: "anthropic",
        model: "claude-opus-5",
      },
      retired: {
        label: "Retired",
        provider: "anthropic",
        model: "claude-opus-5",
        status: "disabled",
      },
      byok: { label: "My OpenAI", provider: "openai", model: "gpt-5.5" },
      "half-made": { label: "Half Made", provider: "anthropic" },
    },
    profileOrder: ["balanced", "my-custom", "retired", "byok", "half-made"],
    activeProfile: "balanced",
    callSites: {},
  },
};

// Storybook has no daemon, so both queries the section reads are seeded
// through the generated factories; HeyAPI bakes path params into the key, so
// a hand-written key would miss and the section would render its loader.
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
  client.setQueryData(inferenceProfilesGetOptions({ path }).queryKey, {
    profiles: PROFILES,
  });
  client.setQueryData(configGetOptions({ path }).queryKey, CONFIG);
  return client;
}

const meta: Meta<typeof ProfilesSection> = {
  title: "Settings/AI/ProfilesSection",
  component: ProfilesSection,
  args: {
    assistantId: ASSISTANT_ID,
    config: CONFIG,
    selectedProfileName: null,
    onOpenProfile: () => {},
    onCreateProfile: () => {},
    onProfileDeleted: () => {},
  },
  decorators: [
    (Story) => (
      <QueryClientProvider client={seededClient()}>
        <div style={{ maxWidth: 640, padding: 24 }}>
          <Story />
        </div>
      </QueryClientProvider>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof ProfilesSection>;

/**
 * Every row state the list can show, including the two that need attention.
 *
 * "My OpenAI" has a credential problem and "Half Made" was never finished.
 * Both carry the warning icon, with the reason on hover, so a profile that
 * cannot serve a request is visible in the one place you would go to repair
 * it. Before the availability change, only the credential case showed
 * anything: an unfinished profile rendered exactly like a healthy one while
 * the resolver skipped it on every turn.
 */
export const Default: Story = {};
