import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";

import {
  mcpCatalogEntry,
  mcpServer,
  oauthConnection,
  oauthProvider,
} from "../integration-test-fixtures";
import type { McpServerEntry } from "../mcp/mcp-api";
import type {
  McpCatalogConnectRequest,
  McpCatalogResponse,
} from "../mcp/mcp-catalog-api";
import { mcpQueryKeys } from "../mcp/mcp-query-keys";

let catalog: McpCatalogResponse;
let servers: McpServerEntry[];
let accounts: ReturnType<typeof oauthConnection>[];
let catalogFails = false;
let removeFails = false;
let authStatus = "pending";
let authAttemptId: string | undefined = "attempt-example";
let browserFinished: (() => void) | undefined;
let popup: {
  opener: unknown;
  closed: boolean;
  close: ReturnType<typeof mock>;
  location: { replace: ReturnType<typeof mock> };
};
const openPopup = mock(() => popup);
const start = mock(async (_assistantId: string, _serverId: string) => ({
  auth_url: "https://example.com/authorize",
  state: "state-example",
  attempt_id: "attempt-example",
}));
const cancel = mock(async () => ({ cancelled: true }));
const toolsSummary = mock(async () => ({ servers: [] }));
const remove = mock(async (_assistantId: string, serverId: string) => {
  if (removeFails) {
    throw new Error("Cleanup unavailable");
  }
  servers = servers.filter((server) => server.id !== serverId);
});
const create = mock(
  async (_assistantId: string, request: McpCatalogConnectRequest) => {
    expect(openPopup).toHaveBeenCalled();
    const saved = servers.find(
      (server) =>
        server.catalog?.id === request.catalogId &&
        server.catalog.serverKey === request.serverKey,
    );
    if (saved) {
      return { serverId: saved.id, created: false };
    }
    const serverId = `saved-${request.catalogId}`;
    servers.push(
      mcpServer({
        id: serverId,
        lifecycleState: "needs-auth",
        source: "workspace",
        catalog: {
          id: request.catalogId,
          serverKey: request.serverKey,
          definitionDigest: request.definitionDigest,
        },
      }),
    );
    return { serverId, created: true };
  },
);
const disconnectOAuth = mock(() => {});

mock.module("@/assistant/use-active-assistant-id", () => ({
  useActiveAssistantId: () => "assistant-123",
}));
mock.module("@/hooks/use-is-org-ready", () => ({ useIsOrgReady: () => true }));
mock.module("@/hooks/use-platform-assistant-id", () => ({
  usePlatformAssistantId: () => ({
    platformAssistantId: "platform-123",
    isLoading: false,
    error: null,
  }),
}));
const actualGate = await import("@/hooks/use-platform-gate");
mock.module("@/hooks/use-platform-gate", () => ({
  ...actualGate,
  usePlatformGate: () => "full",
  useActiveAssistantIsPlatformHosted: () => true,
}));
const actualFlags = await import("@/stores/assistant-feature-flag-store");
mock.module("@/stores/assistant-feature-flag-store", () => ({
  ...actualFlags,
  useAssistantFeatureFlagStore: {
    use: { mcpAddServer: () => true, hasHydrated: () => true },
  },
}));
const actualDaemonQueries = await import(
  "@/generated/daemon/@tanstack/react-query.gen"
);
mock.module("@/generated/daemon/@tanstack/react-query.gen", () => ({
  ...actualDaemonQueries,
  oauthProvidersGetOptions: () => ({
    queryKey: ["catalog-test-providers"],
    queryFn: async () => ({ providers: [oauthProvider()] }),
  }),
}));
const actualApiQueries = await import(
  "@/generated/api/@tanstack/react-query.gen"
);
mock.module("@/generated/api/@tanstack/react-query.gen", () => ({
  ...actualApiQueries,
  assistantsOauthConnectionsListOptions: () => ({
    queryKey: ["catalog-test-accounts"],
    queryFn: async () => accounts,
  }),
  useAssistantsOauthDisconnectByConnectionCreateMutation: () => ({
    mutate: disconnectOAuth,
    isPending: false,
  }),
}));
mock.module("@/hooks/use-managed-oauth-connect", () => ({
  useManagedOAuthConnect: () => ({
    status: "idle",
    connect: () => {},
    dismiss: () => {},
    errorMessage: null,
  }),
}));
const actualNative = await import("@/runtime/native-auth");
mock.module("@/runtime/native-auth", () => ({
  ...actualNative,
  isNativePlatform: () => false,
}));
mock.module("@/runtime/is-electron", () => ({ isElectron: () => false }));
const actualBrowser = await import("@/runtime/browser");
mock.module("@/runtime/browser", () => ({
  ...actualBrowser,
  openUrlInNewTab: async () => true,
  openUrlFinishedListener: (callback: () => void) => {
    browserFinished = callback;
    return () => {
      browserFinished = undefined;
    };
  },
}));
mock.module("@/lib/sentry/capture-error", () => ({ captureError: () => {} }));
const actualMcp = await import("../mcp/mcp-api");
mock.module("../mcp/mcp-api", () => ({
  ...actualMcp,
  fetchMcpServers: async () => ({ servers: [...servers] }),
  fetchMcpToolsSummary: toolsSummary,
  startMcpAuth: start,
  pollMcpAuthStatus: async () => ({
    status: authStatus,
    attempt_id: authAttemptId,
  }),
  cancelMcpAuth: cancel,
  removeMcpServer: remove,
}));
mock.module("../mcp/mcp-catalog-api", () => ({
  fetchMcpCatalog: async () => {
    if (catalogFails) {
      throw new Error("Catalog unavailable");
    }
    return catalog;
  },
  connectMcpCatalogEntry: create,
}));
const { IntegrationsPage } = await import("./integrations-page");
let client: QueryClient;

beforeEach(() => {
  catalog = { supportsConnect: true, entries: [mcpCatalogEntry()] };
  servers = [];
  accounts = [];
  catalogFails = false;
  removeFails = false;
  authStatus = "pending";
  authAttemptId = "attempt-example";
  popup = {
    opener: {},
    closed: false,
    close: mock(() => {}),
    location: { replace: mock(() => {}) },
  };
  openPopup.mockClear();
  start.mockClear();
  cancel.mockClear();
  create.mockClear();
  remove.mockClear();
  toolsSummary.mockClear();
  disconnectOAuth.mockClear();
  window.open = openPopup as unknown as typeof window.open;
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => {
  cleanup();
  client.clear();
});
function showPage() {
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <IntegrationsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
function row(name: string) {
  return within(
    screen
      .getByText(name, { exact: true })
      .closest<HTMLElement>("[data-slot=card]")!,
  );
}
async function beginFathom() {
  showPage();
  await screen.findByText("Fathom");
  fireEvent.click(row("Fathom").getByRole("button", { name: "Connect" }));
  await waitFor(() =>
    expect(start).toHaveBeenCalledWith("assistant-123", "saved-fathom"),
  );
  await waitFor(() => expect(popup.location.replace).toHaveBeenCalled());
}
async function completeFathom() {
  authStatus = "complete";
  servers = servers.map((server) => ({
    ...server,
    lifecycleState: "connected",
  }));
  act(() => browserFinished?.());
  await waitFor(() =>
    expect(
      Boolean(row("Fathom").queryByRole("button", { name: "Connecting..." })),
    ).toBe(false),
  );
  await waitFor(() => row("Fathom").getByText("Connected"));
}
async function openDisconnect(name: string) {
  fireEvent.pointerDown(
    row(name).getByRole("button", { name: /More actions/ }),
    { button: 0, ctrlKey: false },
  );
  fireEvent.click(await screen.findByRole("menuitem", { name: "Disconnect" }));
}

describe("catalog discovery and connection UI", () => {
  test("Configure receives optional diagnostics and tool limits without fetching details for the list", async () => {
    servers = [mcpServer({ lifecycleState: "error", diagnostic: "tools-discovery-failed" })];
    toolsSummary.mockImplementationOnce(async () => ({
      servers: [],
      limits: { perServer: 20, global: 50 },
    }));
    showPage();
    await screen.findByText("example-integration");
    expect(toolsSummary).not.toHaveBeenCalled();
    expect(screen.queryByText(/its tools could not be loaded/)).toBeNull();
    fireEvent.click(row("example-integration").getByRole("button", { name: "Configure" }));
    await screen.findByText("Up to 20 tools per integration and 50 tools across all integrations can be registered.");
    screen.getByText("The integration connected, but its tools could not be loaded. Refresh integrations to try again.");
  });

  test("duplicate saved instances have distinct rows and exact disconnect confirmations", async () => {
    const definition = mcpCatalogEntry();
    servers = ["saved-one", "saved-two"].map((id) => mcpServer({
      id,
      catalog: {
        id: definition.id,
        serverKey: definition.serverKey,
        definitionDigest: definition.definitionDigest,
      },
    }));
    showPage();
    await screen.findByText("Fathom");
    fireEvent.click(row("Fathom").getByRole("button", { name: "Configure" }));
    await screen.findByText("Fathom (saved-one)");
    screen.getByText("Fathom (saved-two)");
    await openDisconnect("Fathom (saved-two)");
    const confirmation = screen.getByRole("dialog", { name: /Disconnect/ });
    expect(confirmation.textContent).toContain("Fathom (saved-two)");
    expect(confirmation.textContent).not.toContain("saved-one");
    fireEvent.click(within(confirmation).getByRole("button", { name: "Disconnect" }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith("assistant-123", "saved-two"));
    await waitFor(() => expect(screen.queryByText("Fathom (saved-one)")).toBeNull());
    expect(servers.map((server) => server.id)).toEqual(["saved-one"]);
    expect(screen.queryByText("Fathom (saved-two)")).toBeNull();
  });

  test("Configure waits for a fresh summary before showing a cached empty result", async () => {
    const definition = mcpCatalogEntry();
    servers = [
      mcpServer({
        id: "saved-fathom",
        catalog: {
          id: definition.id,
          serverKey: definition.serverKey,
          definitionDigest: definition.definitionDigest,
        },
      }),
    ];
    client.setQueryData(mcpQueryKeys.details("assistant-123"), { servers: [] });
    let finish: (() => void) | undefined;
    toolsSummary.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ servers: [] });
        }),
    );
    showPage();
    await screen.findByText("Fathom");
    fireEvent.click(row("Fathom").getByRole("button", { name: "Configure" }));
    await waitFor(() => expect(toolsSummary).toHaveBeenCalledTimes(1));
    screen.getByText("Loading tools...");
    expect(
      Boolean(
        screen.queryByText("No tools are registered for this connection."),
      ),
    ).toBe(false);
    act(() => finish?.());
    await screen.findByText("No tools are registered for this connection.");
  });

  test("creates, authorizes, configures lazily, and disconnects back to Available", async () => {
    await beginFathom();
    screen.getByText(
      "Complete authorization for Fathom in the browser, then return here.",
    );
    row("Fathom").getByText("Connecting");
    expect(document.body.textContent).not.toContain("saved-fathom");
    expect(create.mock.calls[0]?.[1]).toEqual({
      catalogId: "fathom",
      serverKey: "fathom",
      definitionDigest: "a".repeat(64),
      setupAcknowledged: false,
    });
    expect(toolsSummary).not.toHaveBeenCalled();
    await completeFathom();
    fireEvent.click(row("Fathom").getByRole("button", { name: "Configure" }));
    await waitFor(() => expect(toolsSummary).toHaveBeenCalledTimes(1));
    screen.getByRole("dialog", { name: "Fathom" });
    expect(document.body.textContent).not.toContain("saved-fathom");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await openDisconnect("Fathom");
    expect(
      screen.getByRole("dialog", { name: /Disconnect/ }).textContent,
    ).toContain("Fathom");
    expect(document.body.textContent).not.toContain("saved-fathom");
    fireEvent.click(
      within(screen.getByRole("dialog", { name: /Disconnect/ })).getByRole(
        "button",
        { name: "Disconnect" },
      ),
    );
    await waitFor(() => row("Fathom").getByRole("button", { name: "Connect" }));
    expect(remove).toHaveBeenCalledWith("assistant-123", "saved-fathom");
    expect(servers).toHaveLength(0);
  });

  test("cancels the exact attempt and finishes the saved connection without creating a duplicate", async () => {
    await beginFathom();
    fireEvent.click(
      await screen.findByRole("button", { name: "Cancel connection" }),
    );
    await waitFor(() =>
      expect(cancel).toHaveBeenCalledWith(
        "assistant-123",
        "saved-fathom",
        "attempt-example",
      ),
    );
    await waitFor(() =>
      row("Fathom").getByRole("button", { name: "Finish connecting" }),
    );
    fireEvent.click(
      row("Fathom").getByRole("button", { name: "Finish connecting" }),
    );
    await waitFor(() => expect(start).toHaveBeenCalledTimes(2));
    expect(create).toHaveBeenCalledTimes(1);
  });

  test("closing the owned popup exposes Retry and can finish after a late callback", async () => {
    await beginFathom();
    popup.closed = true;
    await screen.findByRole("button", { name: "Retry" });
    screen.getByText(
      "Finish signing in to Fathom, or retry to open sign-in again. We will keep checking for completed authorization.",
    );
    row("Fathom").getByRole("button", { name: "Finish connecting" });
    expect(cancel).not.toHaveBeenCalled();
    await completeFathom();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    await waitFor(() => expect(client.isFetching()).toBe(0));
  });

  test("superseded authorization offers Stop waiting without stale cancellation", async () => {
    authAttemptId = undefined;
    await beginFathom();
    const dismiss = await screen.findByRole("button", { name: "Stop waiting" });
    expect(
      screen.queryByRole("button", { name: "Cancel connection" }),
    ).toBeNull();
    await act(async () => fireEvent.click(dismiss));
    expect(cancel).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Stop waiting" })).toBeNull();
    await waitFor(() => expect(client.isFetching()).toBe(0));
  });

  test("a failed authorization start retries the saved ID without creating another connection", async () => {
    start.mockImplementationOnce(async () => {
      throw new Error("Authorization unavailable");
    });
    showPage();
    await screen.findByText("Fathom");
    fireEvent.click(row("Fathom").getByRole("button", { name: "Connect" }));
    const retry = await screen.findByRole("button", { name: "Retry" });
    expect(screen.getAllByText("Fathom", { exact: true })).toHaveLength(2);
    expect(document.body.textContent).not.toContain("saved-fathom");
    fireEvent.click(retry);
    await waitFor(() => expect(start).toHaveBeenCalledTimes(2));
    expect(start.mock.calls[1]).toEqual(["assistant-123", "saved-fathom"]);
    screen.getByText(
      "Complete authorization for Fathom in the browser, then return here.",
    );
    expect(create).toHaveBeenCalledTimes(1);
    expect(servers).toHaveLength(1);
  });

  test("a saved connection stays removable when its definition is absent", async () => {
    catalog.entries = [];
    servers = [
      mcpServer({
        id: "saved-removed-provider",
        catalog: {
          id: "removed",
          serverKey: "removed",
          definitionDigest: "a".repeat(64),
        },
      }),
    ];
    showPage();
    await screen.findByText("removed", { exact: true });
    expect(document.body.textContent).not.toContain("saved-removed-provider");
    await openDisconnect("removed");
    fireEvent.click(
      within(screen.getByRole("dialog", { name: /Disconnect/ })).getByRole(
        "button",
        { name: "Disconnect" },
      ),
    );
    await waitFor(() => expect(servers).toHaveLength(0));
  });

  test("a brand without accounts opens the chooser instead of choosing a method", async () => {
    catalog.entries = [
      mcpCatalogEntry({
        id: "notion",
        serverKey: "notion",
        displayName: "Notion",
        oauthProvider: "notion",
      }),
    ];
    showPage();
    await screen.findByText("Notion");
    fireEvent.click(row("Notion").getByRole("button", { name: "Connect" }));
    await screen.findByText("Notion MCP");
    screen.getByText("Vellum connection");
    expect(create).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  test("manual prerequisites require acknowledgement before creating or authorizing", async () => {
    catalog.entries = [
      mcpCatalogEntry({
        setup: {
          mode: "manual",
          instructions: "Ask an administrator to enable this integration.",
        },
      }),
    ];
    showPage();
    await screen.findByText("Fathom");
    fireEvent.click(row("Fathom").getByRole("button", { name: "Set up" }));
    screen.getByText("Ask an administrator to enable this integration.");
    expect(
      (screen.getByRole("button", { name: "Connect" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(create).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create.mock.calls[0]?.[1]?.setupAcknowledged).toBe(true);
  });

  test("cleanup failure keeps the connection and confirmation available for retry", async () => {
    await beginFathom();
    await completeFathom();
    removeFails = true;
    await openDisconnect("Fathom");
    fireEvent.click(
      within(screen.getByRole("dialog", { name: /Disconnect/ })).getByRole(
        "button",
        { name: "Disconnect" },
      ),
    );
    await waitFor(() => expect(remove).toHaveBeenCalledTimes(1));
    expect(servers).toHaveLength(1);
    removeFails = false;
    await waitFor(() =>
      expect(
        (
          within(screen.getByRole("dialog", { name: /Disconnect/ })).getByRole(
            "button",
            { name: "Disconnect" },
          ) as HTMLButtonElement
        ).disabled,
      ).toBe(false),
    );
    fireEvent.click(
      within(screen.getByRole("dialog", { name: /Disconnect/ })).getByRole(
        "button",
        { name: "Disconnect" },
      ),
    );
    await waitFor(() => expect(servers).toHaveLength(0));
  });

  test("catalog outage and old assistants preserve saved connections without catalog writes", async () => {
    catalogFails = true;
    servers = [mcpServer({ id: "saved-custom" })];
    const view = showPage();
    await screen.findByText("saved-custom");
    await screen.findByText(/The integration catalog could not be loaded/);
    expect(create).not.toHaveBeenCalled();
    view.unmount();
    client.clear();
    catalogFails = false;
    catalog = { supportsConnect: false, entries: [mcpCatalogEntry()] };
    showPage();
    await screen.findByText("saved-custom");
    expect(Boolean(screen.queryByText("Fathom"))).toBe(false);
    screen.getByRole("button", { name: "Add custom integration" });
  });

  test("mapped brands offer an explicit method chooser and preserve named OAuth account targets", async () => {
    catalog.entries = [
      mcpCatalogEntry({
        id: "notion",
        serverKey: "notion",
        displayName: "Notion",
        oauthProvider: "notion",
      }),
    ];
    accounts = [
      oauthConnection({
        id: "failed-account",
        connected: false,
        account_label: "Example failed account",
      }),
      oauthConnection({
        id: "working-account",
        account_label: "Example working account",
      }),
    ];
    servers = [
      mcpServer({
        id: "notion-server",
        catalog: {
          id: "notion",
          serverKey: "notion",
          definitionDigest: "a".repeat(64),
        },
      }),
    ];
    showPage();
    await screen.findByText("Notion");
    fireEvent.click(row("Notion").getByRole("button", { name: "Configure" }));
    await screen.findByText("Notion MCP");
    within(screen.getByRole("dialog", { name: "Notion" })).getByRole("button", {
      name: /More actions.*Notion/,
    });
    expect(document.body.textContent).not.toContain("notion-server");
    expect(create).not.toHaveBeenCalled();
    fireEvent.click(
      row("Vellum connection").getByRole("button", { name: "Configure" }),
    );
    await screen.findByText("Example failed account");
    fireEvent.click(
      screen.getByRole("button", { name: "Disconnect Example failed account" }),
    );
    fireEvent.click(
      within(screen.getByRole("dialog", { name: /Disconnect/ })).getByRole(
        "button",
        { name: "Disconnect" },
      ),
    );
    expect(disconnectOAuth).toHaveBeenCalledWith({
      path: { assistant_id: "platform-123", connection_id: "failed-account" },
    });
  });
});
