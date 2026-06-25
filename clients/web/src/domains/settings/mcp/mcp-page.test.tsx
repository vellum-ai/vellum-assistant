import { afterEach, describe, expect, mock, test } from "bun:test";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router";

let assistantFlags: Record<string, boolean> = {};
let flagsHydrated = true;

const navigateToNewConversation = mock((..._args: unknown[]) => {});
mock.module("@/utils/conversation-navigation", () => ({
  navigateToNewConversation,
}));

mock.module("@/assistant/use-active-assistant-id", () => ({
  useActiveAssistantId: () => "assistant-123",
}));

mock.module("@/stores/assistant-feature-flag-store", () => {
  const store = () => null;
  store.use = {
    mcpAddServer: () => assistantFlags.mcpAddServer ?? false,
    hasHydrated: () => flagsHydrated,
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
  revokeMcpOAuth: mock(async () => {}),
  updateMcpServer: mock(async () => {}),
}));

const { McpPage } = await import("./mcp-page");

function Wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return (
    <QueryClientProvider client={client}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}

afterEach(() => {
  cleanup();
  assistantFlags = {};
  flagsHydrated = true;
  navigateToNewConversation.mockClear();
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

  test("empty state starts a setup conversation when the mcpAddServer flag is off", async () => {
    assistantFlags = { mcpAddServer: false };

    render(<McpPage />, { wrapper: Wrapper });

    const cta = await screen.findByRole("button", {
      name: /Chat with your assistant to set up an MCP server/,
    });
    fireEvent.click(cta);

    expect(navigateToNewConversation).toHaveBeenCalledTimes(1);
    expect(navigateToNewConversation.mock.calls[0]?.[1]).toMatchObject({
      prompt: expect.stringContaining("MCP server"),
    });
  });

  test("empty state opens the add server modal when the mcpAddServer flag is on", async () => {
    assistantFlags = { mcpAddServer: true };

    render(<McpPage />, { wrapper: Wrapper });

    const cta = await screen.findByRole("button", {
      name: /Add an MCP server to extend your assistant with external tools/,
    });
    fireEvent.click(cta);

    expect(navigateToNewConversation).not.toHaveBeenCalled();
  });

  test("empty state CTA stays inert until feature flags hydrate", async () => {
    assistantFlags = { mcpAddServer: false };
    flagsHydrated = false;

    render(<McpPage />, { wrapper: Wrapper });

    const cta = await screen.findByRole("button", {
      name: /Chat with your assistant to set up an MCP server/,
    });
    expect((cta as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(cta);

    expect(navigateToNewConversation).not.toHaveBeenCalled();
  });
});
