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

  test("opens on what is connected, and chips only what is not working", () => {
    modal({ plan: connectedPlan });

    expect(screen.queryByText("Connected")).toBeNull();
    screen.getByText("Needs attention");
  });

  test("confirms a disconnect in the words of the thing being removed", async () => {
    modal({ plan: connectedPlan });

    openMenu("More actions for Notion MCP server");
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Disconnect" }),
    );

    await screen.findByText("Disconnect Notion MCP server?");
    screen.getByText(
      "Vellum removes the Notion MCP server and its tools. You can connect it again at any time.",
    );

    expect(handlers.onDisconnect).not.toHaveBeenCalled();
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
