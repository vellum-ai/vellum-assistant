import type { Meta, StoryObj } from "@storybook/react-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fn } from "storybook/test";

import { assistantsDomainsListQueryKey } from "@/generated/api/@tanstack/react-query.gen";
import type { Assistant } from "@/generated/api/types.gen";

import { AssistantHandleModal } from "./assistant-handle-modal";

const ASSISTANT = {
  id: "00000000-0000-4000-8000-000000000001",
  name: "Velly",
  handle: "velly",
} as unknown as Assistant;

/** Seeds the domain list, so the story decides whether the handle is held. */
function withDomains(subdomain: string | null) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(
    assistantsDomainsListQueryKey({ path: { assistant_id: ASSISTANT.id } }),
    { results: subdomain ? [{ id: "domain-1", subdomain }] : [] },
  );
  return client;
}

const meta: Meta<typeof AssistantHandleModal> = {
  title: "Components/AssistantHandleModal",
  component: AssistantHandleModal,
  args: {
    assistant: ASSISTANT,
    open: true,
    onOpenChange: fn().mockName("onOpenChange"),
  },
};

export default meta;
type Story = StoryObj<typeof AssistantHandleModal>;

/** The handle is free to change: Save is present throughout and disabled at rest. */
export const Editable: Story = {
  decorators: [
    (Story) => (
      <QueryClientProvider client={withDomains(null)}>
        <Story />
      </QueryClientProvider>
    ),
  ],
};

/** A registered subdomain holds the handle, so it reads only, with the way out. */
export const HeldByDomain: Story = {
  decorators: [
    (Story) => (
      <QueryClientProvider client={withDomains("velly")}>
        <Story />
      </QueryClientProvider>
    ),
  ],
};
