import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import {
  NOTION_PROVIDER,
  mcpServer,
  notionPlan,
  oauthConnection,
  planFor,
  pluginDefinition,
} from "../integration-story-fixtures";
import {
  IntegrationConnectModal,
  type IntegrationConnectModalProps,
} from "./integration-connect-modal";

const handlers = {
  onConnect: mock(() => {}),
  onLogin: mock(() => {}),
  onCancelAttempt: mock(() => {}),
  onRetryAttempt: mock(() => {}),
  onReconnect: mock(() => {}),
  onDisconnect: mock(() => {}),
  onOpenTools: mock(() => {}),
  onCopyCallbackUrl: mock(() => {}),
  onOpenSetupGuide: mock(() => {}),
  onClose: mock(() => {}),
};

/** A provider that allowlists a callback URL before sign-in works. */
const manualPlan = planFor({
  definitions: [
    pluginDefinition({
      pluginName: "ramp-mcp",
      displayName: "Ramp",
      description: "Cards, bills, and spend limits from Ramp.",
      oauthProvider: undefined,
      setup: {
        mode: "manual",
        instructions: "An admin has to allowlist our callback URL first.",
      },
    }),
  ],
});

/** Vellum's hosted sign-in and nothing else, the shape a host is asked for. */
const hostedOnlyPlan = planFor({ providers: [NOTION_PROVIDER] });

/** Notion over both its MCP server and a Vellum-hosted account. */
const connectedPlan = planFor({
  providers: [NOTION_PROVIDER],
  connections: [oauthConnection("notion", { connected: false })],
  servers: [mcpServer("notion-mcp", { id: "notion" })],
  definitions: [pluginDefinition()],
});

function modal(overrides: Partial<IntegrationConnectModalProps> = {}) {
  return render(
    <IntegrationConnectModal {...handlers} plan={notionPlan} {...overrides} />,
  );
}

/** Radix opens a menu on pointer-down, not on a synthetic click. */
function openMenu(name: string) {
  fireEvent.pointerDown(screen.getByRole("button", { name }), {
    button: 0,
    ctrlKey: false,
  });
}

afterEach(() => {
  cleanup();
  for (const handler of Object.values(handlers)) {
    handler.mockClear();
  }
});

describe("IntegrationConnectModal", () => {
  test("leads with one connect action and keeps the rest behind it", async () => {
    modal();

    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    expect(handlers.onConnect).toHaveBeenCalledTimes(1);

    openMenu("Other ways to connect Notion");
    await screen.findByRole("menuitem", { name: "Sign in through Vellum" });
  });

  test("opens on the method the caller picked", () => {
    const own = planFor({
      providers: [NOTION_PROVIDER],
      definitions: [pluginDefinition()],
      ownOAuthAvailable: true,
    });
    const ownMethod = own.alternatives.find(
      (method) => method.kind === "own-oauth",
    )!;
    modal({
      plan: own,
      focusMethodId: ownMethod.id,
      ownOAuthContent: <p>Your own OAuth app</p>,
    });

    screen.getByText("Your own OAuth app");
  });

  test("walks a manual setup through the callback URL it was given", () => {
    modal({
      plan: manualPlan,
      callbackUrl: {
        status: "ready",
        url: "https://assistant.example.com/v1/mcp/callback",
      },
      onCopyCallbackUrl: () => {},
    });

    screen.getByText("https://assistant.example.com/v1/mcp/callback");
    expect(
      (screen.getByRole("button", { name: "Connect" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  test("offers a plain Connect where there is no callback URL to hand over", () => {
    modal({ plan: manualPlan });

    screen.getByText("An admin has to allowlist our callback URL first.");
    expect(screen.queryByRole("button", { name: "Copy" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    expect(handlers.onConnect).toHaveBeenCalledTimes(1);
  });

  test("opens on what is connected, and chips only what is not working", () => {
    modal({ plan: connectedPlan });

    expect(screen.queryByText("Connected")).toBeNull();
    screen.getByText("Needs attention");
  });

  test("asks one plain question before removing an MCP server", async () => {
    modal({ plan: connectedPlan });

    fireEvent.click(
      screen.getByRole("button", { name: "Remove Notion MCP server" }),
    );

    await screen.findByText("Remove Notion MCP server?");
    screen.getByText("Are you sure?");

    expect(handlers.onDisconnect).not.toHaveBeenCalled();
  });

  test("asks an account the same question, and removes it on confirm", async () => {
    modal({ plan: connectedPlan });

    fireEvent.click(
      screen.getByRole("button", { name: "Remove user@example.com" }),
    );

    await screen.findByText("Remove user@example.com?");
    screen.getByText("Are you sure?");

    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(handlers.onDisconnect).toHaveBeenCalledTimes(1);
  });

  test("stays open on the connections the answer leaves behind", async () => {
    modal({ plan: connectedPlan });

    fireEvent.click(
      screen.getByRole("button", { name: "Remove user@example.com" }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Remove" }));

    // Answering the question closes the question, not the dialog that asked
    // it: the other connection still has a row to act on.
    expect(handlers.onClose).not.toHaveBeenCalled();
    screen.getByText("Notion MCP server");
    expect(screen.queryByText("Are you sure?")).toBeNull();
  });

  test("leaves out an MCP server a plugin has already installed", async () => {
    modal({ plan: connectedPlan });

    openMenu("Connect another");
    await screen.findByRole("menuitem", { name: "Sign in through Vellum" });
    expect(
      screen.queryByRole("menuitem", { name: "Notion MCP server" }),
    ).toBeNull();
  });

  test("stays open while Connect another shows its methods", async () => {
    modal({ plan: connectedPlan });

    // The sequence a browser produces here: the menu's layer sets the dialog
    // content to `pointer-events: none`, so the press lands on the trigger and
    // the click lands on the backdrop showing through it. A backdrop press is
    // the only gesture that dismisses, and this is not one.
    openMenu("Connect another");
    await screen.findByRole("menuitem", { name: "Sign in through Vellum" });

    const overlay = document.body.querySelector('[data-slot="modal-overlay"]');
    expect(overlay).not.toBeNull();
    fireEvent.click(overlay as Element);

    expect(handlers.onClose).not.toHaveBeenCalled();
    screen.getByRole("menuitem", { name: "Sign in through Vellum" });
  });

  test("drops Connect another when the only path is already connected", () => {
    modal({
      plan: planFor({
        servers: [mcpServer("notion-mcp", { id: "notion" })],
        definitions: [pluginDefinition({ oauthProvider: undefined })],
      }),
    });

    expect(
      screen.queryByRole("button", { name: "Connect another" }),
    ).toBeNull();
  });

  test("names a sibling server by its own id", async () => {
    const twoServers = planFor({
      servers: [
        mcpServer("ashby-mcp", { id: "ashby-jobs" }),
        mcpServer("ashby-mcp", { id: "ashby-candidates" }),
      ],
      definitions: [
        pluginDefinition({
          pluginName: "ashby-mcp",
          displayName: "Ashby",
          description: "Search candidates and jobs in Ashby.",
          oauthProvider: undefined,
        }),
      ],
    });
    modal({ plan: twoServers });

    // Siblings are told apart by their own ids, not by one shared label.
    fireEvent.click(screen.getByRole("button", { name: "Remove ashby-jobs" }));

    await screen.findByText("Remove ashby-jobs?");
    screen.getByText("Are you sure?");
  });

  test("keeps a row for an installed plugin that declared no server", async () => {
    const noServers = planFor({
      definitions: [
        pluginDefinition({
          pluginName: "ashby-mcp",
          displayName: "Ashby",
          description: "Search candidates and jobs in Ashby.",
          oauthProvider: undefined,
          installed: {},
        }),
      ],
    });
    modal({ plan: noServers });

    // With no server of its own the row is named after the method, and it is
    // still the row that takes the plugin away.
    fireEvent.click(
      screen.getByRole("button", { name: "Remove Ashby MCP server" }),
    );

    await screen.findByText("Remove Ashby MCP server?");
    screen.getByText("Are you sure?");
  });

  test("puts an MCP server's tools behind the row they belong to", async () => {
    modal({
      plan: connectedPlan,
      toolsByConnectionId: {
        "mcp:notion": {
          endpointUrl: "https://mcp.example.com/notion-mcp",
          summary: {
            serverId: "notion",
            toolCount: 1,
            estimatedTokens: 1840,
            tools: [
              {
                name: "search_pages",
                description: "Full-text search across the workspace.",
                estimatedTokens: 1840,
              },
            ],
          },
        },
      },
    });

    fireEvent.click(
      screen.getByRole("button", {
        name: "Tools and details for Notion MCP server",
      }),
    );

    await screen.findByText("https://mcp.example.com/notion-mcp");
    expect(handlers.onOpenTools).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "search_pages" }));
    screen.getByText("Full-text search across the workspace.");
  });

  test("says the tools are on their way, and when they never came", async () => {
    const { rerender } = modal({
      plan: connectedPlan,
      toolsByConnectionId: { "mcp:notion": { loading: true } },
    });

    fireEvent.click(
      screen.getByRole("button", {
        name: "Tools and details for Notion MCP server",
      }),
    );
    await screen.findByRole("status");
    screen.getByText("Loading tools...");

    rerender(
      <IntegrationConnectModal
        {...handlers}
        plan={connectedPlan}
        toolsByConnectionId={{ "mcp:notion": { error: true } }}
      />,
    );
    await screen.findByRole("alert");
    screen.getByText("The tool list could not be loaded.");
  });

  test("connect another leads back out to a method", async () => {
    modal({ plan: connectedPlan });

    openMenu("Connect another");
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Sign in through Vellum" }),
    );

    await screen.findByRole("heading", { name: "Connect Notion" });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    expect(handlers.onConnect).toHaveBeenCalledTimes(1);
  });

  test("asks a per-tenant provider which host before it will connect", () => {
    modal({
      plan: hostedOnlyPlan,
      tenantHost: {
        pattern: "^[a-z0-9-]+\\.example\\.com$",
        label: "Store domain",
        placeholder: "store.example.com",
      },
    });

    const connect = screen.getByRole("button", {
      name: "Connect",
    }) as HTMLButtonElement;
    expect(connect.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText("Store domain"), {
      target: { value: "shop.example.com" },
    });
    expect(connect.disabled).toBe(false);
    fireEvent.click(connect);
    expect(handlers.onConnect).toHaveBeenCalledWith(
      hostedOnlyPlan.primary,
      expect.objectContaining({ tenantHost: "shop.example.com" }),
    );
  });

  test("falls back to the connect view when nothing is connected any more", () => {
    const { rerender } = modal({ plan: connectedPlan });
    screen.getByText("Manage how Vellum connects to Notion.");

    rerender(
      <IntegrationConnectModal {...handlers} plan={notionPlan} />,
    );
    screen.getByRole("heading", { name: "Connect Notion" });
  });
});
