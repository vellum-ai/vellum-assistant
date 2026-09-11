import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";

import type { McpServerEntry } from "./mcp-api";
import { McpServerDetailModal } from "./mcp-server-detail-modal";

const server: McpServerEntry = {
  id: "example-integration",
  status: "connected",
  transport: { type: "streamable-http", url: "https://example.com/mcp" },
  hasOAuth: false,
  hasStaticAuth: false,
  authType: "none",
};
const handlers = {
  server,
  onClose: () => {},
  onSave: () => {},
  isPending: false,
};

afterEach(cleanup);

describe("McpServerDetailModal", () => {
  test("shows technical details and complete tool descriptions in Configure", () => {
    const description =
      "Read the full project report, including every section and linked document.";
    render(
      <McpServerDetailModal
        {...handlers}
        toolsSummary={{
          serverId: server.id,
          toolCount: 1,
          estimatedTokens: 200,
          tools: [
            {
              name: "read_project_report_with_linked_documents",
              description,
              estimatedTokens: 200,
            },
          ],
        }}
      />,
    );

    screen.getByText(server.transport.url!);
    screen.getByText(description);
    expect(screen.queryByRole("table")).toBeNull();
    screen.getByText("~200 tokens");
  });

  test("distinguishes loading and failed tool summaries from an empty connection", () => {
    const { rerender } = render(
      <McpServerDetailModal
        {...handlers}
        toolsSummary={undefined}
        toolsLoading
      />,
    );
    screen.getByText("Loading tools...");
    expect(
      screen.queryByText("No tools are registered for this connection."),
    ).toBeNull();

    rerender(
      <McpServerDetailModal
        {...handlers}
        toolsSummary={undefined}
        toolsError
      />,
    );
    screen.getByRole("alert");
    expect(
      screen.queryByText("No tools are registered for this connection."),
    ).toBeNull();
  });

  test.each([
    ["connection-failed", "The integration could not connect."],
    ["authorization-required", "The integration requires authorization."],
    ["tools-discovery-failed", "The integration connected, but its tools could not be loaded."],
    ["connection-closed", "The integration connection closed."],
  ])("explains the %s diagnostic in Configure", (diagnostic, message) => {
    render(
      <McpServerDetailModal
        {...handlers}
        server={{ ...server, lifecycleState: "error", diagnostic }}
        toolsSummary={undefined}
      />,
    );
    expect(screen.getByRole("status").textContent).toContain(message);
    expect(screen.queryByText(diagnostic)).toBeNull();
  });

  test("shows supplied tool limits even when no tools are registered and hides absent compatibility fields", () => {
    const { rerender } = render(
      <McpServerDetailModal
        {...handlers}
        toolsSummary={undefined}
        toolLimits={{ perServer: 20, global: 50 }}
      />,
    );
    screen.getByText("Up to 20 tools per integration and 50 tools across all integrations can be registered.");
    screen.getByText("No tools are registered for this connection.");

    rerender(
      <McpServerDetailModal
        {...handlers}
        server={{ ...server, diagnostic: "unknown-future-diagnostic" }}
        toolsSummary={undefined}
      />,
    );
    expect(screen.queryByText(/across all integrations/)).toBeNull();
    expect(screen.queryByText("unknown-future-diagnostic")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });

  test("plugin details cannot edit headers or save workspace configuration", () => {
    render(
      <McpServerDetailModal
        {...handlers}
        server={{ ...server, source: "plugin", pluginName: "example-plugin" }}
        toolsSummary={undefined}
      />,
    );
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    screen.getByText(server.transport.url!);
  });
});
