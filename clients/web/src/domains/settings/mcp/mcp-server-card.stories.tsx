import type { Meta, StoryObj } from "@storybook/react-vite";

import type { McpServerEntry } from "./mcp-api";
import { McpServerCard } from "./mcp-server-card";

const meta: Meta<typeof McpServerCard> = {
  title: "Settings/McpServerCard",
  component: McpServerCard,
  parameters: { layout: "padded" },
  args: {
    isAuthenticating: false,
    onRemove: () => {},
    onConfigure: () => {},
    onAuthenticate: () => {},
    onManagePlugin: () => {},
  },
};

export default meta;
type Story = StoryObj<typeof McpServerCard>;

function server(overrides: Partial<McpServerEntry> = {}): McpServerEntry {
  return {
    id: "meeting-notes",
    status: "needs-auth",
    transport: {
      type: "streamable-http",
      url: "https://mcp.example.com/mcp",
    },
    hasOAuth: false,
    hasStaticAuth: false,
    authType: "none",
    ...overrides,
  };
}

export const NeedsAuth: Story = { args: { server: server() } };
export const Mobile: Story = {
  args: { server: server() },
  globals: { viewport: { value: "sbMobile", isRotated: false } },
};
export const Authenticating: Story = {
  args: { server: server(), isAuthenticating: true },
};
export const Connected: Story = {
  args: { server: server({ status: "connected", hasOAuth: true }) },
};
export const StaleGrant: Story = {
  args: { server: server({ hasOAuth: true }) },
};
export const Error: Story = {
  args: { server: server({ status: "unreachable" }) },
};
export const Plugin: Story = {
  args: {
    server: server({
      source: "plugin",
      pluginName: "meeting-notes-plugin",
    }),
  },
};
export const NarrowMobile: Story = {
  args: {
    server: server({
      id: "shared-workspace-financial-reporting-and-meeting-notes",
    }),
  },
  globals: { viewport: { value: "sbNarrowPhone", isRotated: false } },
};
