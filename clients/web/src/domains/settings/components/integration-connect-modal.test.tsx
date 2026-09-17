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

    openMenu("More actions for Notion MCP server");
    fireEvent.click(await screen.findByRole("menuitem", { name: "Remove" }));

    // One server, but still a whole plugin going, and a plugin is more than
    // its servers: the confirmation is scoped to what the uninstall takes.
    await screen.findByText("Disconnect Notion?");
    screen.getByText(
      "Vellum removes Notion and everything it installed, including its MCP server and the tools it brings. You can connect it again at any time.",
    );

    expect(handlers.onDisconnect).not.toHaveBeenCalled();
  });

  test("names the whole plugin when one row would take its siblings", async () => {
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
    openMenu("More actions for ashby-jobs");
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Disconnect" }),
    );

    await screen.findByText("Disconnect Ashby?");
    screen.getByText(
      "Vellum removes Ashby and everything it installed, including all 2 of its MCP servers and the tools they bring. You can connect it again at any time.",
    );
  });

  test("counts no servers rather than inventing one for an installed plugin", async () => {
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

    // With no server of its own the row is named after the method, and the
    // plugin is still the thing the disconnect takes away.
    openMenu("More actions for Ashby MCP server");
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Disconnect" }),
    );

    await screen.findByText("Disconnect Ashby?");
    screen.getByText(
      "Vellum removes Ashby and everything it installed. You can connect it again at any time.",
    );
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

    openMenu("More actions for Notion MCP server");
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Tools and details" }),
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

    openMenu("More actions for Notion MCP server");
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Tools and details" }),
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
