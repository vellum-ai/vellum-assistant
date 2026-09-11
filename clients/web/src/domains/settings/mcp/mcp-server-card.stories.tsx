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
  },
};

export default meta;
type Story = StoryObj<typeof McpServerCard>;

function server(overrides: Partial<McpServerEntry> = {}): McpServerEntry {
  return {
    id: "meeting-notes",
    status: "needs-auth",
    transport: { type: "streamable-http", url: "https://mcp.example.com/mcp" },
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
export const Authenticating: Story = { args: { server: server(), isAuthenticating: true } };
export const Connected: Story = { args: { server: server({ status: "connected", hasOAuth: true }) } };
export const StaleGrant: Story = { args: { server: server({ hasOAuth: true }) } };
export const Error: Story = { args: { server: server({ status: "unreachable" }) } };
export const NarrowMobile: Story = {
  args: { server: server({ id: "shared-workspace-financial-reporting-and-meeting-notes" }) },
  globals: { viewport: { value: "sbNarrowPhone", isRotated: false } },
};
export const MobileStates: Story = {
  args: { server: server() },
  globals: { viewport: { value: "sbMobile", isRotated: false } },
  render: (args) => (
    <div className="space-y-2">
      <McpServerCard {...args} server={server({ status: "connected" })} />
      <McpServerCard {...args} server={server({ id: "shared-finance-and-business-reporting", hasOAuth: true })} />
      <McpServerCard {...args} server={server({ id: "Заметки-команды-и-отчёты-по-проектам" })} />
      <McpServerCard {...args} server={server({ id: "project-tracker", status: "unreachable" })} />
    </div>
  ),
};
