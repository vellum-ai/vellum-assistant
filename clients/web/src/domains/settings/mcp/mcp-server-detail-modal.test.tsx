import { afterEach, describe, expect, mock, test } from "bun:test";
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
const onSave = mock(() => {});
const handlers = {
  server,
  onClose: () => {},
  onSave,
  isPending: false,
};

afterEach(() => {
  cleanup();
  onSave.mockClear();
});

describe("McpServerDetailModal", () => {
  test("shows transport and complete tool details inside Configure", () => {
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

  test("plugin details do not expose workspace configuration writes", () => {
    render(
      <McpServerDetailModal
        {...handlers}
        server={{ ...server, source: "plugin", pluginName: "example-plugin" }}
        toolsSummary={undefined}
        readOnly
      />,
    );

    expect(screen.getAllByRole("button", { name: "Close" })).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(screen.queryByLabelText("Authentication")).toBeNull();
    expect(onSave).not.toHaveBeenCalled();
  });
});
