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

    await screen.findByText("Remove Notion MCP server?");
    screen.getByText("Are you sure?");

    expect(handlers.onDisconnect).not.toHaveBeenCalled();
  });

  test("asks an account the same question, and removes it on confirm", async () => {
    modal({ plan: connectedPlan });

    openMenu("More actions for user@example.com");
    fireEvent.click(await screen.findByRole("menuitem", { name: "Remove" }));

    await screen.findByText("Remove user@example.com?");
    screen.getByText("Are you sure?");

    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(handlers.onDisconnect).toHaveBeenCalledTimes(1);
  });

  test("leaves out an MCP server a plugin has already installed", async () => {
    modal({ plan: connectedPlan });

    openMenu("Connect another");
    await screen.findByRole("menuitem", { name: "Sign in through Vellum" });
    expect(
      screen.queryByRole("menuitem", { name: "Notion MCP server" }),
    ).toBeNull();
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
    fireEvent.click(screen.getByRole("button", { name: "search_pages" }));
    screen.getByText("Full-text search across the workspace.");
  });
});
