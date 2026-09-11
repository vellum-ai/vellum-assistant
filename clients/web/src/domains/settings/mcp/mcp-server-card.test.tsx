import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import type { McpServerEntry } from "./mcp-api";
import { McpServerCard } from "./mcp-server-card";

const handlers = {
  onRemove: mock(() => {}),
  onConfigure: mock(() => {}),
  onAuthenticate: mock(() => {}),
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
});

describe("McpServerCard", () => {
  test("a working grant offers Configure without OAuth or technical metadata", () => {
    render(<McpServerCard {...handlers} server={server({ hasOAuth: true })} />);

    fireEvent.click(screen.getByRole("button", { name: "Configure" }));
    expect(handlers.onConfigure).toHaveBeenCalledWith("example-meeting-notes");
    expect(screen.queryByText("Authenticated")).toBeNull();
    expect(screen.queryByText("streamable-http")).toBeNull();
    expect(
      screen.queryByRole("button", { name: /Authenticate|Re-auth|Revoke/ }),
    ).toBeNull();
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.queryByText(/registered tools/i)).toBeNull();
  });

  test("a missing grant offers one labeled action to finish connecting", () => {
    render(
      <McpServerCard {...handlers} server={server({ status: "needs-auth" })} />,
    );

    screen.getByText("Needs attention");
    fireEvent.click(screen.getByRole("button", { name: "Finish connecting" }));
    expect(handlers.onAuthenticate).toHaveBeenCalledWith(
      "example-meeting-notes",
    );
  });

  test("keeps diagnostics out of the compact row", () => {
    render(
      <McpServerCard
        {...handlers}
        server={server({ lifecycleState: "error", diagnostic: "connection-failed" })}
      />,
    );
    screen.getByText("Needs attention");
    expect(screen.queryByText("connection-failed")).toBeNull();
    expect(screen.queryByText(/The integration could not connect/)).toBeNull();
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
        server={server({ status: "needs-auth", transport: { type: "stdio" } })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Configure" }));
    expect(handlers.onConfigure).toHaveBeenCalledTimes(1);
    expect(handlers.onAuthenticate).not.toHaveBeenCalled();
  });

  test("authentication in progress keeps a labeled disabled action", () => {
    render(
      <McpServerCard
        {...handlers}
        server={server({ status: "needs-auth" })}
        isAuthenticating
      />,
    );

    expect(
      (screen.getByRole("button", {
        name: "Connecting...",
      }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  test("the actions menu keeps Configure and removal reachable during recovery", async () => {
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
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Remove integration" }),
    );
    expect(handlers.onRemove).toHaveBeenCalledWith("example-meeting-notes");
  });
  test("plugin ownership offers management and read-only details without workspace removal", async () => {
    const onManagePlugin = mock(() => {});
    render(
      <McpServerCard
        {...handlers}
        onManagePlugin={onManagePlugin}
        server={server({
          source: "plugin",
          pluginName: "example-plugin",
          lifecycleState: "declared",
        })}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Manage plugin" }));
    expect(onManagePlugin).toHaveBeenCalledWith("example-plugin");
    fireEvent.pointerDown(
      screen.getByRole("button", {
        name: "More actions for example-meeting-notes",
      }),
      { button: 0, ctrlKey: false },
    );
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "View details" }),
    );
    expect(handlers.onConfigure).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByRole("menuitem", { name: "Remove integration" }),
    ).toBeNull();
  });

  test("a static credential error configures credentials without starting OAuth", () => {
    render(
      <McpServerCard
        {...handlers}
        server={server({ lifecycleState: "needs-auth", hasStaticAuth: true })}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Configure" }));
    expect(handlers.onAuthenticate).not.toHaveBeenCalled();
  });
});
