import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { expect, screen, userEvent, waitFor } from "storybook/test";

import {
  GOOGLE_PROVIDER,
  LINEAR_PROVIDER,
  NOTION_PROVIDER,
  ashbyPlan,
  mcpServer,
  notionPlan,
  oauthConnection,
  planFor,
  pluginDefinition,
} from "../integration-story-fixtures";
import type { McpToolEntry, McpToolsSummaryServer } from "../mcp/mcp-api";

import {
  IntegrationConnectModal,
  type IntegrationConnectModalProps,
} from "./integration-connect-modal";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function tool(
  name: string,
  description: string,
  estimatedTokens: number,
): McpToolEntry {
  return { name, description, estimatedTokens };
}

function toolsSummary(serverId: string): McpToolsSummaryServer {
  const tools = [
    tool(
      "list_issues",
      "List issues in a team, optionally filtered by state, assignee, or label.",
      1840,
    ),
    tool(
      "create_issue",
      "Create an issue with a title, description, team, and optional assignee.",
      2210,
    ),
    tool(
      "update_issue",
      "Change the state, assignee, estimate, or description of an existing issue.",
      1975,
    ),
    tool(
      "search_documents",
      "Full-text search across documents the workspace can read.",
      1420,
    ),
    tool("list_teams", "List the teams in the workspace.", 1119),
  ];
  return {
    serverId,
    toolCount: tools.length,
    estimatedTokens: tools.reduce(
      (total, entry) => total + entry.estimatedTokens,
      0,
    ),
    tools,
  };
}

const linearServer = mcpServer("linear-mcp", { id: "linear" });
const linearPlan = planFor({
  providers: [LINEAR_PROVIDER],
  servers: [linearServer],
  definitions: [
    pluginDefinition({
      pluginName: "linear-mcp",
      displayName: "Linear MCP",
      description: "Issues, projects, and documents from Linear's own server.",
      oauthProvider: "linear",
    }),
  ],
});

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/**
 * The modal is pure, so the story owns every effect. The panel records each
 * callback the surface fires, which is what makes a review of "what does this
 * button actually do" possible without wiring the page.
 */
function Harness(args: IntegrationConnectModalProps) {
  const [log, setLog] = useState<string[]>([]);
  const [copied, setCopied] = useState(false);

  const record = (entry: string) => setLog((entries) => [...entries, entry]);

  return (
    <>
      <div className="fixed top-2 left-2 z-[60] max-w-xs rounded-md border border-[var(--border-base)] bg-[var(--surface-lift)] p-2">
        <p className="text-label-small-default text-[var(--content-tertiary)]">
          Callbacks
        </p>
        <ul className="mt-1 space-y-0.5">
          {log.length === 0 ? (
            <li className="text-body-small-default text-[var(--content-tertiary)]">
              none yet
            </li>
          ) : (
            log.map((entry, index) => (
              <li
                key={`${entry}-${index}`}
                className="font-mono text-body-small-default text-[var(--content-secondary)] [overflow-wrap:anywhere]"
              >
                {entry}
              </li>
            ))
          )}
        </ul>
      </div>
      <IntegrationConnectModal
        {...args}
        callbackCopied={copied}
        onConnect={(method, options) =>
          record(`onConnect(${method.id}, ${JSON.stringify(options)})`)
        }
        onLogin={() => record("onLogin()")}
        onCancelAttempt={() => record("onCancelAttempt()")}
        onRetryAttempt={() => record("onRetryAttempt()")}
        onReconnect={(connection) => record(`onReconnect(${connection.id})`)}
        onDisconnect={(connection) => record(`onDisconnect(${connection.id})`)}
        onCopyCallbackUrl={(url) => {
          setCopied(true);
          record(`onCopyCallbackUrl(${url})`);
        }}
        onOpenSetupGuide={(url) => record(`onOpenSetupGuide(${url})`)}
        onClose={() => record("onClose()")}
      />
    </>
  );
}

const noop = () => {};

const meta: Meta<typeof IntegrationConnectModal> = {
  title: "Settings/IntegrationConnectModal",
  component: IntegrationConnectModal,
  parameters: { layout: "fullscreen" },
  args: {
    plan: notionPlan,
    onConnect: noop,
    onLogin: noop,
    onCancelAttempt: noop,
    onRetryAttempt: noop,
    onReconnect: noop,
    onDisconnect: noop,
    onCopyCallbackUrl: noop,
    onOpenSetupGuide: noop,
    onClose: noop,
  },
  argTypes: {
    plan: { control: false },
    ownOAuthContent: { control: false },
    toolsByConnectionId: { control: false },
  },
  render: (args) => <Harness {...args} />,
};

export default meta;
type Story = StoryObj<typeof IntegrationConnectModal>;

/** Platform-hosted: the MCP server leads and the chevron offers only "Sign in through Vellum". */
export const NotionPlatformHosted: Story = {};

/** Self-hosted: the same two paths plus "Use your own OAuth app" behind the chevron. */
export const NotionSelfHosted: Story = {
  args: {
    plan: planFor({
      providers: [NOTION_PROVIDER],
      definitions: [pluginDefinition()],
      ownOAuthAvailable: true,
    }),
  },
};

/** One path, so no chevron: the split button collapses to a plain Connect. */
export const GoogleManagedOnly: Story = {
  args: { plan: planFor({ providers: [GOOGLE_PROVIDER] }) },
};

/** Without a platform session the managed path is a login, not a connect. */
export const LoginRequired: Story = {
  args: {
    plan: planFor({
      providers: [GOOGLE_PROVIDER],
      platformGate: "disabled",
    }),
  },
};

/** A server whose provider must allowlist our callback URL before sign-in. */
export const RampManual: Story = {
  args: {
    plan: planFor({
      definitions: [
        pluginDefinition({
          pluginName: "ramp-mcp",
          displayName: "Ramp",
          description: "Cards, bills, and spend limits from Ramp.",
          oauthProvider: undefined,
          setup: {
            mode: "manual",
            instructions:
              "Ramp allowlists one callback URL per workspace, so an admin has to add ours before sign-in works.",
          },
        }),
      ],
    }),
    callbackUrl: {
      status: "ready",
      url: "https://assistant.example.com/v1/mcp/callback",
    },
  },
};

/** Sign-in has moved to the browser and the modal is waiting for it. */
export const Waiting: Story = {
  args: {
    attempt: {
      methodId: notionPlan.primary.id,
      phase: "waiting",
      canCancel: true,
    },
  },
};

/** The grant landed; the server is coming up. */
export const Connecting: Story = {
  args: {
    attempt: {
      methodId: notionPlan.primary.id,
      phase: "connecting",
      canCancel: false,
    },
  },
};

/**
 * Only after a failure does the modal spend the user's attention on what the
 * provider requires: before that, the requirements are noise on a path that
 * usually just works.
 */
export const Failed: Story = {
  args: {
    plan: ashbyPlan,
    attempt: {
      methodId: ashbyPlan.primary.id,
      phase: "error",
      error: "Ashby rejected the sign-in.",
      canCancel: true,
    },
  },
};

/**
 * With a connection in place the modal opens on what is already connected.
 * The plugin installs once, so with no other path there is no "Connect
 * another" here: the row on screen is everything this integration can be.
 */
export const ConnectedMcp: Story = {
  args: {
    plan: planFor({
      servers: [mcpServer("notion-mcp", { id: "notion" })],
      definitions: [pluginDefinition({ oauthProvider: undefined })],
    }),
  },
};

/**
 * Two live paths to one integration, told apart by their method tag. Only the
 * hosted sign-in takes another account, so it is the whole "Connect another"
 * menu.
 */
export const ConnectedBoth: Story = {
  args: {
    plan: planFor({
      providers: [NOTION_PROVIDER],
      connections: [oauthConnection("notion")],
      servers: [mcpServer("notion-mcp", { id: "notion" })],
      definitions: [pluginDefinition()],
    }),
  },
};

/** A stale grant on each path: the only rows that earn a status chip. */
export const NeedsAttention: Story = {
  args: {
    plan: planFor({
      providers: [NOTION_PROVIDER],
      connections: [
        oauthConnection("notion", { connected: false, status: "REVOKED" }),
      ],
      servers: [
        mcpServer("notion-mcp", { id: "notion", status: "needs-auth" }),
      ],
      definitions: [pluginDefinition()],
    }),
  },
};

/**
 * What a connection costs, behind the row it belongs to: the endpoint, the
 * per-turn token overhead, and the tool names, with the descriptions folded
 * away until asked for.
 */
export const ToolsAndDetails: Story = {
  args: {
    plan: linearPlan,
    toolsByConnectionId: {
      "mcp:linear": {
        summary: toolsSummary("linear"),
        endpointUrl: linearServer.transport.url,
      },
    },
  },
  play: async () => {
    const menuTrigger = await screen.findByRole("button", {
      name: "More actions for Linear MCP server",
    });
    await userEvent.click(menuTrigger);
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Tools and details" }),
    );
    await waitFor(async () => {
      await expect(
        screen.getByRole("button", { name: "list_issues" }),
      ).toBeInTheDocument();
    });
  },
};

export const Mobile: Story = {
  globals: { viewport: { value: "sbMobile", isRotated: false } },
};
