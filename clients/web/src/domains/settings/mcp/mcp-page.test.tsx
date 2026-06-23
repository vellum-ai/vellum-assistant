import { afterEach, describe, expect, mock, test } from "bun:test";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

let assistantFlags: Record<string, boolean> = {};

mock.module("@/assistant/use-active-assistant-id", () => ({
  useActiveAssistantId: () => "assistant-123",
}));

mock.module("@/stores/assistant-feature-flag-store", () => {
  const store = () => null;
  store.use = {
    mcpAddServer: () => assistantFlags.mcpAddServer ?? false,
  };
  return { useAssistantFeatureFlagStore: store };
});

mock.module("@vellumai/design-library/components/button", () => ({
  Button: ({
    children,
    iconOnly,
    leftIcon,
    size: _size,
    tooltip: _tooltip,
    variant: _variant,
    ...props
  }: {
    children?: ReactNode;
    iconOnly?: ReactNode;
    leftIcon?: ReactNode;
    size?: string;
    tooltip?: string;
    variant?: string;
  }) => (
    <button {...props}>
      {iconOnly}
      {leftIcon}
      {children}
    </button>
  ),
}));

mock.module("@vellumai/design-library/components/confirm-dialog", () => ({
  ConfirmDialog: () => null,
}));

mock.module("@vellumai/design-library/components/toast", () => ({
  toast: { error: () => {}, success: () => {} },
}));

mock.module("./mcp-api", () => ({
  fetchMcpServers: mock(async () => ({ servers: [] })),
  fetchMcpToolsSummary: mock(async () => ({
    servers: [],
    totalToolCount: 0,
    totalEstimatedTokens: 0,
  })),
  addMcpServer: mock(async () => {}),
  startMcpAuth: mock(async () => ({
    auth_url: "https://example.com/oauth",
    state: "state-123",
  })),
  pollMcpAuthStatus: mock(async () => ({ status: "pending" })),
  reloadMcpServers: mock(async () => {}),
  removeMcpServer: mock(async () => {}),
  updateMcpServer: mock(async () => {}),
}));

const { McpPage } = await import("./mcp-page");

function Wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

afterEach(() => {
  cleanup();
  assistantFlags = {};
});

describe("McpPage", () => {
  test("hides the add server button when the mcpAddServer flag is off", async () => {
    assistantFlags = { mcpAddServer: false };

    render(<McpPage />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(screen.getByText("MCP Servers")).not.toBeNull();
    });
    expect(screen.queryByRole("button", { name: "Add Server" })).toBeNull();
  });

  test("shows the add server button when the mcpAddServer flag is on", async () => {
    assistantFlags = { mcpAddServer: true };

    render(<McpPage />, { wrapper: Wrapper });

    expect(
      await screen.findByRole("button", { name: "Add Server" }),
    ).not.toBeNull();
  });
});
