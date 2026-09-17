import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import type { McpServerEntry } from "./mcp-api";
import { McpServerCard } from "./mcp-server-card";

const handlers = {
  onRemove: mock(() => {}),
  onConfigure: mock(() => {}),
  onAuthenticate: mock(() => {}),
  onManagePlugin: mock(() => {}),
  isAuthenticating: false,
};

function server(overrides: Partial<McpServerEntry> = {}): McpServerEntry {
  return {
    id: "example-meeting-notes",
    status: "connected",
    transport: { type: "streamable-http", url: "https://example.com/mcp" },
    hasOAuth: false,
    hasStaticAuth: false,
    authType: "none",
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  handlers.onRemove.mockClear();
  handlers.onConfigure.mockClear();
  handlers.onAuthenticate.mockClear();
  handlers.onManagePlugin.mockClear();
});

describe("McpServerCard", () => {
  test("a legacy workspace payload offers Configure without technical metadata", () => {
    render(<McpServerCard {...handlers} server={server({ hasOAuth: true })} />);

    fireEvent.click(
      screen.getByRole("button", { name: "Configure example-meeting-notes" }),
    );
    expect(handlers.onConfigure).toHaveBeenCalledWith("example-meeting-notes");
    expect(screen.queryByText("Connected")).toBeNull();
    expect(screen.queryByText("Authenticated")).toBeNull();
    expect(screen.queryByText("streamable-http")).toBeNull();
    expect(
      screen.queryByRole("button", { name: /Authenticate|Re-auth|Revoke/ }),
    ).toBeNull();
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.queryByText(/registered tools/i)).toBeNull();
  });

  test("a missing grant offers one action to finish connecting", () => {
    render(
      <McpServerCard {...handlers} server={server({ status: "needs-auth" })} />,
    );

    screen.getByText("Needs attention");
    fireEvent.click(screen.getByRole("button", { name: "Finish connecting" }));
    expect(handlers.onAuthenticate).toHaveBeenCalledWith(
      "example-meeting-notes",
    );
  });

  test("a stale grant offers Reconnect", () => {
    render(
      <McpServerCard
        {...handlers}
        server={server({ status: "needs-auth", hasOAuth: true })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
    expect(handlers.onAuthenticate).toHaveBeenCalledTimes(1);
    expect(screen.queryByLabelText("Revoke")).toBeNull();
  });

  test("a local server opens Configure instead of starting OAuth", () => {
    render(
      <McpServerCard
        {...handlers}
        server={server({
          status: "needs-auth",
          transport: { type: "stdio" },
        })}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Configure example-meeting-notes" }),
    );
    expect(handlers.onConfigure).toHaveBeenCalledTimes(1);
    expect(handlers.onAuthenticate).not.toHaveBeenCalled();
  });

  test("a plugin server offers management and read-only details only", async () => {
    render(
      <McpServerCard
        {...handlers}
        server={server({
          source: "plugin",
          pluginName: "example-plugin",
          status: "needs-auth",
        })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Manage plugin" }));
    expect(handlers.onManagePlugin).toHaveBeenCalledWith("example-plugin");
    expect(
      screen.queryByRole("button", { name: "Finish connecting" }),
    ).toBeNull();

    fireEvent.pointerDown(
      screen.getByRole("button", {
        name: "More actions for example-meeting-notes",
      }),
      { button: 0, ctrlKey: false },
    );
    const viewDetails = await screen.findByRole("menuitem", {
      name: "View details",
    });
    expect(screen.queryByRole("menuitem", { name: "Remove" })).toBeNull();
    fireEvent.click(viewDetails);
    expect(handlers.onConfigure).toHaveBeenCalledWith("example-meeting-notes");
  });

  test("a partial plugin row opens generic plugin management", () => {
    render(
      <McpServerCard
        {...handlers}
        server={server({ source: "plugin", pluginName: undefined })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Manage plugin" }));
    expect(handlers.onManagePlugin).toHaveBeenCalledWith(undefined);
    expect(screen.queryByRole("button", { name: "Remove" })).toBeNull();
  });

  test("the workspace action menu keeps Configure and Remove reachable during recovery", async () => {
    render(
      <McpServerCard {...handlers} server={server({ status: "needs-auth" })} />,
    );

    fireEvent.pointerDown(
      screen.getByRole("button", {
        name: "More actions for example-meeting-notes",
      }),
      { button: 0, ctrlKey: false },
    );
    fireEvent.click(await screen.findByRole("menuitem", { name: "Configure" }));
    expect(handlers.onConfigure).toHaveBeenCalledTimes(1);

    fireEvent.pointerDown(
      screen.getByRole("button", {
        name: "More actions for example-meeting-notes",
      }),
      { button: 0, ctrlKey: false },
    );
    fireEvent.click(await screen.findByRole("menuitem", { name: "Remove" }));
    expect(handlers.onRemove).toHaveBeenCalledWith("example-meeting-notes");
  });
});
