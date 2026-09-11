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
