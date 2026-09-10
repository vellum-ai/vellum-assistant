import type { Meta, StoryObj } from "@storybook/react-vite";

import type { McpServerEntry } from "./mcp-api";
import { McpServerCard } from "./mcp-server-card";

/**
 * One MCP connection in Settings: what it is, how it is doing, and the
 * things you can do to it.
 *
 * The row is the same control set at every width. What changes on a narrow
 * window is the first action's label, which drops to its icon so the cluster
 * still fits beside the name; the label stays on as the tooltip and the
 * accessible name. See the Mobile story, which renders at the shared narrow
 * viewport rather than describing itself.
 */
const meta: Meta<typeof McpServerCard> = {
  title: "Settings/McpServerCard",
  component: McpServerCard,
  parameters: {
    layout: "padded",
  },
  args: {
    toolsSummary: undefined,
    isAuthenticating: false,
    isRevoking: false,
    onRemove: () => {},
    onConfigure: () => {},
    onAuthenticate: () => {},
    onRevokeOAuth: () => {},
  },
};

export default meta;
type Story = StoryObj<typeof McpServerCard>;

function server(overrides: Partial<McpServerEntry> = {}): McpServerEntry {
  return {
    id: "figma",
    status: "needs-auth",
    transport: { type: "streamable-http", url: "https://mcp.example.com/mcp" },
    hasOAuth: false,
    hasStaticAuth: false,
    authType: "none",
    ...overrides,
  };
}

/** A server that is on and waiting to be authenticated. */
export const NeedsAuth: Story = {
  args: { server: server() },
};

/** The same row at a phone's width: the label gives way, the actions do not. */
export const Mobile: Story = {
  args: { server: server() },
  globals: { viewport: { value: "sbMobile", isRotated: false } },
};

/** Authentication in flight: the button holds the spinner and stops taking clicks. */
export const Authenticating: Story = {
  args: { server: server(), isAuthenticating: true },
};

/** Connected, with the tool counts the summary adds to the subtitle. */
export const Connected: Story = {
  args: {
    server: server({ status: "connected" }),
    toolsSummary: {
      serverId: "figma",
      toolCount: 41,
      estimatedTokens: 18422,
      tools: [
        {
          name: "get_design_context",
          description: "Reference code and metadata for a node.",
          estimatedTokens: 812,
        },
        {
          name: "get_screenshot",
          description: "Render a node as a PNG.",
          estimatedTokens: 415,
        },
      ],
    },
  },
};

/**
 * Authenticated: the chip says so, and the Authenticate button is gone, since
 * there is nothing left to authenticate. Revoke stays as the way back out.
 */
export const Authenticated: Story = {
  args: {
    server: server({ status: "connected", hasOAuth: true }),
  },
};

/**
 * Stale credentials: tokens are still on disk, so `hasOAuth` is true, but the
 * health check says they no longer authenticate. The row has to offer the way
 * back in rather than claiming to be authenticated, or the only route out is
 * revoking first.
 */
export const StaleGrant: Story = {
  args: {
    server: server({ status: "needs-auth", hasOAuth: true }),
  },
};

/** Anything the client does not recognise reads as an error. */
export const Error: Story = {
  args: { server: server({ status: "unreachable" }) },
};
