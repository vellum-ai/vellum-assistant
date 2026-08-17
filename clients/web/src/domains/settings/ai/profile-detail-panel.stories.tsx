import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Meta, StoryObj } from "@storybook/react-vite";

import {
  configGetQueryKey,
  inferenceProviderconnectionsGetQueryKey,
} from "@/generated/daemon/@tanstack/react-query.gen";
import type { ConfigGetResponse, ProviderConnection } from "@/generated/daemon/types.gen";

import { ProfileDetailPanel } from "./profile-detail-panel";

const ASSISTANT_ID = "story-assistant";

const CONNECTIONS: ProviderConnection[] = [
  {
    name: "anthropic-personal",
    label: null,
    provider: "anthropic",
    auth: { type: "api_key", credential: "credential/anthropic/api_key" },
    models: null,
  } as unknown as ProviderConnection,
];

const CONFIG: ConfigGetResponse = {
  llm: {
    profiles: {
      balanced: {
        label: "Balanced",
        provider: "vellum",
        model: "glm-5.2",
        source: "managed",
        invariant: true,
      },
      "my-custom": {
        label: "My Custom",
        provider: "anthropic",
        model: "claude-opus-5",
        source: "user",
      },
    },
    profileOrder: ["balanced", "my-custom"],
    activeProfile: "balanced",
    callSites: {},
  },
};

function seededClient() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  const path = { assistant_id: ASSISTANT_ID };
  client.setQueryData(configGetQueryKey({ path }), CONFIG);
  client.setQueryData(inferenceProviderconnectionsGetQueryKey({ path }), {
    connections: CONNECTIONS,
  });
  return client;
}

function withClient(client: QueryClient) {
  return function Decorator(Story: () => React.ReactElement) {
    return (
      <QueryClientProvider client={client}>
        <div className="h-[640px] w-[420px]">
          <Story />
        </div>
      </QueryClientProvider>
    );
  };
}

const meta: Meta<typeof ProfileDetailPanel> = {
  title: "Settings/AI/ProfileDetailPanel",
  component: ProfileDetailPanel,
  parameters: { layout: "centered" },
  args: {
    assistantId: ASSISTANT_ID,
    onClose: () => {},
  },
  decorators: [withClient(seededClient())],
};

export default meta;
type Story = StoryObj<typeof ProfileDetailPanel>;

export const CreateProfile: Story = {
  args: { profileName: null },
};

export const EditProfile: Story = {
  args: { profileName: "my-custom" },
};

/** Managed profiles open read-only with a "Managed by Vellum" tag and "Save As New". */
export const ManagedProfile: Story = {
  args: { profileName: "balanced" },
};
