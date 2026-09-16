import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { StrictMode, type ReactNode } from "react";

import type {
  IntegrationItem,
  McpPluginDefinition,
  McpPluginMethod,
} from "../integration-items";
import type { McpServerEntry } from "../mcp/mcp-api";
import type { useMcpConnections } from "../mcp/use-mcp-connections";

const install = mock(async () => ({
  data: undefined,
  error: undefined,
  response: new Response(),
}));
const remove = mock(async () => ({
  data: { warnings: [] },
  error: undefined,
  response: new Response(),
}));
const sdkActual = await import("@/generated/daemon/sdk.gen");
mock.module("@/generated/daemon/sdk.gen", () => ({
  ...sdkActual,
  pluginsInstallPost: install,
  pluginsByNameDelete: remove,
}));

const { IntegrationMethodsModal } = await import("./integration-methods-modal");

function TestProviders({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

function renderWithProviders(ui: ReactNode) {
  return render(ui, { wrapper: TestProviders });
}

function definition(
  overrides: Partial<McpPluginDefinition> = {},
): McpPluginDefinition {
  return {
    pluginName: "example-mcp",
    displayName: "Example",
    description: "Example tools",
    documentationUrl: "https://example.com/docs",
    logo: "example.png",
    setup: { mode: "oauth", instructions: "Sign in to Example." },
    installed: {},
    ...overrides,
  };
}

function server(overrides: Partial<McpServerEntry> = {}): McpServerEntry {
  return {
    id: "example-server",
    status: "declared",
    source: "plugin",
    pluginName: "example-mcp",
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

function item(
  method: McpPluginMethod,
): Extract<IntegrationItem, { kind: "plugin" }> {
  return {
    kind: "plugin",
    id: `plugin:${method.definition.pluginName}`,
    name: method.definition.displayName,
    description: method.definition.description,
    configured: Boolean(method.definition.installed),
    method,
  };
}

function connectionHarness(
  refetch: () => Promise<{
    data?: { servers: McpServerEntry[] };
    isError: boolean;
  }>,
) {
  const connect = mock(() => {});
  return {
    connect,
    connections: ({
      auth: {
        isBusy: false,
        attempt: null,
        connect,
        stopWaiting: mock(() => {}),
      },
      list: {
        refetch,
        isFetching: false,
        isError: false,
      },
      setConfigureServerId: mock(() => {}),
    } as unknown) as ReturnType<typeof useMcpConnections>,
  };
}

afterEach(() => {
  cleanup();
  install.mockClear();
  remove.mockClear();
});

afterAll(() => mock.restore());

describe("IntegrationMethodsModal", () => {
  test("offers first sign-in for a declared remote server without stored OAuth", () => {
    const method = { definition: definition(), servers: [server()] };
    const harness = connectionHarness(async () => ({
      data: { servers: method.servers },
      isError: false,
    }));

    renderWithProviders(
      <IntegrationMethodsModal
        assistantId="assistant-123"
        item={item(method)}
        connections={harness.connections}
        oauthDisabled={false}
        onOAuth={() => {}}
        onClose={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    expect(harness.connect).toHaveBeenCalledWith(
      "example-server",
      undefined,
      "Example",
    );
  });

  test("does not silently choose one server after a multi-server install", async () => {
    const ownedServers = [server(), server({ id: "example-admin" })];
    const harness = connectionHarness(async () => ({
      data: { servers: ownedServers },
      isError: false,
    }));
    const method = {
      definition: definition({ installed: undefined }),
      servers: [],
    };

    renderWithProviders(
      <IntegrationMethodsModal
        assistantId="assistant-123"
        item={item(method)}
        connections={harness.connections}
        oauthDisabled={false}
        onOAuth={() => {}}
        onClose={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Install plugin" }));
    await waitFor(() => expect(install).toHaveBeenCalledTimes(1));
    expect(harness.connect).not.toHaveBeenCalled();
  });

  test("requires an explicit sign-in click after plugin installation", async () => {
    const refetch = mock(async () => ({
      data: { servers: [server()] },
      isError: false,
    }));
    const harness = connectionHarness(refetch);
    const method = {
      definition: definition({ installed: undefined }),
      servers: [],
    };

    const view = renderWithProviders(
      <IntegrationMethodsModal
        assistantId="assistant-123"
        item={item(method)}
        connections={harness.connections}
        oauthDisabled={false}
        onOAuth={() => {}}
        onClose={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Install plugin" }));
    await waitFor(() => expect(refetch).toHaveBeenCalledTimes(1));
    expect(harness.connect).not.toHaveBeenCalled();

    const installedMethod = {
      definition: definition(),
      servers: [server()],
    };
    view.rerender(
      <IntegrationMethodsModal
        assistantId="assistant-123"
        item={item(installedMethod)}
        connections={harness.connections}
        oauthDisabled={false}
        onOAuth={() => {}}
        onClose={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    expect(harness.connect).toHaveBeenCalledWith(
      "example-server",
      undefined,
      "Example",
    );
  });

  test("refreshes the installed plugin under StrictMode effect replay", async () => {
    const refetch = mock(async () => ({
      data: { servers: [server()] },
      isError: false,
    }));
    const harness = connectionHarness(refetch);
    const method = {
      definition: definition({ installed: undefined }),
      servers: [],
    };

    renderWithProviders(
      <StrictMode>
        <IntegrationMethodsModal
          assistantId="assistant-123"
          item={item(method)}
          connections={harness.connections}
          oauthDisabled={false}
          onOAuth={() => {}}
          onClose={() => {}}
        />
      </StrictMode>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Install plugin" }));

    await waitFor(() => expect(refetch).toHaveBeenCalledTimes(1));
    expect(harness.connect).not.toHaveBeenCalled();
  });

  test("ignores an install refetch that finishes after the modal unmounts", async () => {
    let resolveRefetch:
      | ((result: {
          data: { servers: McpServerEntry[] };
          isError: false;
        }) => void)
      | undefined;
    const harness = connectionHarness(
      () =>
        new Promise((resolve) => {
          resolveRefetch = resolve;
        }),
    );
    const method = {
      definition: definition({ installed: undefined }),
      servers: [],
    };
    const view = renderWithProviders(
      <IntegrationMethodsModal
        assistantId="assistant-123"
        item={item(method)}
        connections={harness.connections}
        oauthDisabled={false}
        onOAuth={() => {}}
        onClose={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Install plugin" }));
    view.unmount();
    resolveRefetch?.({ data: { servers: [server()] }, isError: false });
    await Promise.resolve();

    expect(harness.connect).not.toHaveBeenCalled();
  });

  test("retries server loading for an installed plugin without reinstalling", async () => {
    const refetch = mock(async () => ({
      data: { servers: [server()] },
      isError: false,
    }));
    const harness = connectionHarness(refetch);
    harness.connections.list.isError = true;
    const method = { definition: definition(), servers: [] };

    renderWithProviders(
      <IntegrationMethodsModal
        assistantId="assistant-123"
        item={item(method)}
        connections={harness.connections}
        oauthDisabled={false}
        onOAuth={() => {}}
        onClose={() => {}}
      />,
    );

    expect(screen.getByText(/MCP servers could not be loaded/)).toBeTruthy();
    expect(screen.queryByText(/did not provide any MCP servers/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() => expect(refetch).toHaveBeenCalledTimes(1));
    expect(install).not.toHaveBeenCalled();
    expect(harness.connect).not.toHaveBeenCalled();
  });

  test("removes the whole plugin and stops waiting for an owned server", async () => {
    const method = {
      definition: definition(),
      servers: [server(), server({ id: "example-admin" })],
    };
    const harness = connectionHarness(async () => ({
      data: { servers: [] },
      isError: false,
    }));
    harness.connections.auth.attempt = {
      operationId: "operation-123",
      serverId: "example-admin",
      displayName: "Example",
      startedAt: Date.now(),
      phase: "waiting",
    };

    renderWithProviders(
      <IntegrationMethodsModal
        assistantId="assistant-123"
        item={item(method)}
        connections={harness.connections}
        oauthDisabled={false}
        onOAuth={() => {}}
        onClose={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Remove plugin" }));
    const removeButtons = screen.getAllByRole("button", {
      name: "Remove plugin",
    });
    fireEvent.click(removeButtons.at(-1)!);

    await waitFor(() => expect(remove).toHaveBeenCalledTimes(1));
    expect(harness.connections.auth.stopWaiting).toHaveBeenCalledTimes(1);
  });
});
