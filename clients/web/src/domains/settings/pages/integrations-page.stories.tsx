import type { Meta, StoryObj } from "@storybook/react-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { assistantsOauthConnectionsListQueryKey } from "@/generated/api/@tanstack/react-query.gen";
import { oauthProvidersGetQueryKey } from "@/generated/daemon/@tanstack/react-query.gen";
import { useAssistantFeatureFlagStore } from "@/stores/assistant-feature-flag-store";
import { useAuthStore } from "@/stores/auth-store";
import { useOrganizationStore } from "@/stores/organization-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";

import {
  mcpCatalogEntry,
  mcpServer,
  oauthConnection,
  oauthProvider,
} from "../integration-test-fixtures";
import { mcpQueryKeys } from "../mcp/mcp-query-keys";
import { IntegrationsPage } from "./integrations-page";

const assistantId = "11111111-2222-4333-8444-555555555555";
const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: false, staleTime: Infinity, refetchOnWindowFocus: false },
  },
});
queryClient.setQueryData(
  oauthProvidersGetQueryKey({ path: { assistant_id: assistantId } }),
  {
    providers: [
      oauthProvider(),
      oauthProvider({
        provider_key: "github",
        display_name: "GitHub",
        description: "Repositories and pull requests",
      }),
    ],
  },
);
queryClient.setQueryData(
  assistantsOauthConnectionsListQueryKey({
    path: { assistant_id: assistantId },
  }),
  [
    oauthConnection({
      id: "account-1",
      connected: false,
      account_label: "Example expired workspace",
    }),
    oauthConnection({
      id: "account-2",
      account_label: "Example connected workspace",
    }),
  ],
);
queryClient.setQueryData(mcpQueryKeys.list(assistantId), {
  servers: [
    mcpServer({ id: "meeting-notes", lifecycleState: "connected" }),
    mcpServer({
      id: "shared-workspace-financial-reporting-and-meeting-notes",
      lifecycleState: "needs-auth",
      hasOAuth: true,
    }),
    mcpServer({
      id: "team-project-documents",
      lifecycleState: "declared",
      source: "plugin",
      pluginName: "team-knowledge",
    }),
  ],
});
queryClient.setQueryData(mcpQueryKeys.details(assistantId), {
  servers: [
    {
      serverId: "meeting-notes",
      toolCount: 1,
      estimatedTokens: 200,
      tools: [
        {
          name: "read_meeting_notes_with_linked_documents",
          description:
            "Read meeting notes with complete decisions, follow-up tasks, and linked documents.",
          estimatedTokens: 200,
        },
      ],
    },
  ],
});

queryClient.setQueryData(mcpQueryKeys.catalog(assistantId), {
  supportsConnect: true,
  entries: [
    mcpCatalogEntry({
      setup: {
        mode: "oauth",
        instructions: "Choose the account whose meeting notes you want to use.",
      },
    }),
    mcpCatalogEntry({
      id: "brex",
      serverKey: "brex",
      displayName: "Brex",
      icon: "brex",
      description: "Review expenses, cards, and company spending.",
      setup: {
        mode: "oauth",
        instructions: "A Brex admin must enable AI assistant access.",
      },
    }),
    mcpCatalogEntry({
      id: "ramp",
      serverKey: "ramp",
      displayName: "Ramp",
      icon: "ramp",
      description: "Explore expenses, bills, and company spending.",
      setup: {
        mode: "manual",
        instructions:
          "Ask an administrator to allow this client's OAuth redirect URI before connecting.",
      },
    }),
    mcpCatalogEntry({
      id: "notion",
      serverKey: "notion",
      displayName: "Notion",
      icon: "notion",
      oauthProvider: "notion",
      description: "Search pages and databases through MCP.",
    }),
    mcpCatalogEntry({
      id: "linear",
      serverKey: "linear",
      displayName: "Linear",
      icon: "linear",
      description: "Find issues, projects, and team updates.",
    }),
  ],
});

const meta: Meta<typeof IntegrationsPage> = {
  title: "Settings/IntegrationsPage",
  component: IntegrationsPage,
  parameters: { layout: "padded" },
  beforeEach: () => {
    const selection = useResolvedAssistantsStore.getState();
    const auth = useAuthStore.getState();
    const org = useOrganizationStore.getState();
    const flags = useAssistantFeatureFlagStore.getState();
    useResolvedAssistantsStore.setState({ activeAssistantId: assistantId });
    useAuthStore.setState({ platformSession: "present" });
    useOrganizationStore.setState({
      currentOrganizationId: "org-example",
      status: "ready",
    });
    useAssistantFeatureFlagStore.setState({
      mcpAddServer: true,
      hasHydrated: true,
    });
    return () => {
      useResolvedAssistantsStore.setState(selection);
      useAuthStore.setState(auth);
      useOrganizationStore.setState(org);
      useAssistantFeatureFlagStore.setState(flags);
    };
  },
  decorators: [
    (Story) => (
      <QueryClientProvider client={queryClient}>
        <div className="mx-auto max-w-3xl">
          <Story />
        </div>
      </QueryClientProvider>
    ),
  ],
};
export default meta;
type Story = StoryObj<typeof IntegrationsPage>;
export const Unified: Story = {};
export const Mobile: Story = {
  globals: { viewport: { value: "sbNarrowPhone", isRotated: false } },
};
