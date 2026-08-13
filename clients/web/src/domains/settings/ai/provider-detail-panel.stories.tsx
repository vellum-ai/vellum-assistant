import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Meta, StoryObj } from "@storybook/react-vite";

import { inferenceProviderconnectionsGetQueryKey } from "@/generated/daemon/@tanstack/react-query.gen";
import type { ProviderConnection } from "@/generated/daemon/types.gen";

import { ProviderDetailPanel } from "./provider-detail-panel";

const ASSISTANT_ID = "story-assistant";

// Casts mirror `profile-detail-panel.test.tsx`'s fixture: `auth`/`models`
// carry unions the story doesn't need to fully enumerate.
const CONNECTIONS: ProviderConnection[] = [
  {
    name: "anthropic-personal",
    label: null,
    provider: "anthropic",
    auth: { type: "api_key", credential: "credential/anthropic/api_key" },
    models: null,
  } as unknown as ProviderConnection,
  {
    name: "openai-work",
    label: "My OpenAI",
    provider: "openai",
    auth: { type: "api_key", credential: "credential/openai/api_key" },
    models: null,
  } as unknown as ProviderConnection,
];

function seededClient() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(
    inferenceProviderconnectionsGetQueryKey({
      path: { assistant_id: ASSISTANT_ID },
    }),
    { connections: CONNECTIONS },
  );
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

const meta: Meta<typeof ProviderDetailPanel> = {
  title: "Settings/AI/ProviderDetailPanel",
  component: ProviderDetailPanel,
  parameters: { layout: "centered" },
  args: {
    assistantId: ASSISTANT_ID,
    onClose: () => {},
  },
  decorators: [withClient(seededClient())],
};

export default meta;
type Story = StoryObj<typeof ProviderDetailPanel>;

/** The add-provider flow: `connectionName: null` runs `ProviderCreateForm`. */
export const AddProvider: Story = {
  args: { connectionName: null },
};

/** Editing an existing connection's stored key and display fields. */
export const EditProvider: Story = {
  args: { connectionName: "anthropic-personal" },
};
