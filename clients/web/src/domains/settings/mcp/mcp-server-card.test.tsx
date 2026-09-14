/**
 * Tests for the MCP server row's authentication states.
 *
 * The three states are worth pinning because two of the inputs disagree: the
 * list route reports `hasOAuth` from the tokens stored on disk, while the
 * health check reports whether those tokens still work. A row that reads the
 * grant alone claims to be authenticated with credentials the server has
 * already rejected, and takes away the only way back in.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";

import type { McpServerEntry } from "@/domains/settings/mcp/mcp-api";
import { McpServerCard } from "@/domains/settings/mcp/mcp-server-card";

const noop = () => {};

const handlers = {
  toolsSummary: undefined,
  onRemove: noop,
  onConfigure: noop,
  onAuthenticate: noop,
  onRevokeOAuth: noop,
  isAuthenticating: false,
  isRevoking: false,
};

function server(overrides: Partial<McpServerEntry> = {}): McpServerEntry {
  return {
    id: "figma",
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
});

describe("McpServerCard authentication states", () => {
  test("a working grant reads as authenticated, with nothing left to do", () => {
    render(<McpServerCard {...handlers} server={server({ hasOAuth: true })} />);

    screen.getByText("Authenticated");
    expect(screen.queryByText("Authenticate")).toBeNull();
    expect(screen.queryByText("Re-auth")).toBeNull();
  });

  test("no grant at all offers first-time authentication", () => {
    render(
      <McpServerCard {...handlers} server={server({ status: "needs-auth" })} />,
    );

    screen.getByText("Needs Auth");
    screen.getByText("Authenticate");
    // Nothing is stored, so there is nothing to revoke.
    expect(screen.queryByLabelText("Revoke")).toBeNull();
  });

  /* Expired or server-side-revoked tokens arrive as `hasOAuth: true` next to a
     `needs-auth` status. Reading the grant alone would show "Needs Auth" and
     "Authenticated" at once and drop the re-auth control, leaving revoking as
     the only route back in. */
  test("a stale grant still offers the way back in", () => {
    render(
      <McpServerCard
        {...handlers}
        server={server({ status: "needs-auth", hasOAuth: true })}
      />,
    );

    expect(screen.queryByText("Authenticated")).toBeNull();
    screen.getByText("Needs Auth");
    screen.getByText("Re-auth");
    // Revoking follows the stored tokens rather than the health check: stale
    // credentials are exactly what someone would want to clear.
    screen.getByLabelText("Revoke");
  });

  test("a local stdio server is never asked to sign in", () => {
    render(
      <McpServerCard
        {...handlers}
        server={server({ status: "needs-auth", transport: { type: "stdio" } })}
      />,
    );

    expect(screen.queryByText("Authenticate")).toBeNull();
  });
});
