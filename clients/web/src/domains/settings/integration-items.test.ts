import { describe, expect, test } from "bun:test";

import {
  buildIntegrationItems,
  filterIntegrationItems,
  supportsMcpAction,
} from "./integration-items";
import {
  mcpServer,
  oauthConnection,
  oauthProvider,
} from "./integration-test-fixtures";

describe("integration presentation", () => {
  test("a working second OAuth account keeps a brand connected", () => {
    const accounts = [
      oauthConnection({ id: "failed", connected: false, status: "ERROR" }),
      oauthConnection(),
    ];
    const items = buildIntegrationItems([oauthProvider()], accounts, []);
    expect(items[0]?.connected).toBe(true);
    expect(filterIntegrationItems(items, "", "connected")).toHaveLength(1);
    expect(filterIntegrationItems(items, "", "available")).toHaveLength(0);
    expect(items[0]?.kind === "oauth" && items[0].connections).toEqual(
      accounts,
    );
  });

  test("keeps custom MCP names distinct from OAuth provider names", () => {
    const items = buildIntegrationItems(
      [oauthProvider()],
      [],
      [mcpServer({ id: "Notion" })],
    );
    expect(items).toHaveLength(2);
    expect(new Set(items.map((item) => item.id)).size).toBe(2);
  });

  test("search applies to existing channel integrations too", () => {
    const items = buildIntegrationItems(
      [oauthProvider({ provider_key: "discord" })],
      [oauthConnection({ provider: "discord" })],
      [],
    );
    expect(filterIntegrationItems(items, "other", "all")).toHaveLength(0);
  });

  test("authoritative runtime state wins over a legacy connected status", () => {
    const items = buildIntegrationItems(
      [],
      [],
      [mcpServer({ lifecycleState: "connecting" })],
    );
    expect(items[0]?.connected).toBe(false);
    expect(filterIntegrationItems(items, "", "available")).toHaveLength(1);
  });

  test("orders configured connections before available providers", () => {
    const items = buildIntegrationItems(
      [oauthProvider({ display_name: "Available" })],
      [],
      [mcpServer({ id: "Zebra", lifecycleState: "error" })],
    );
    expect(
      filterIntegrationItems(items, "", "all").map((item) => item.id),
    ).toEqual(["mcp:Zebra", "oauth:notion"]);
  });

  test("plugin ownership blocks workspace writes even with inconsistent action metadata", () => {
    const server = mcpServer({
      source: "plugin",
      supportedActions: ["configure", "remove", "authenticate"],
    });
    expect(supportsMcpAction(server, "configure")).toBe(false);
    expect(supportsMcpAction(server, "authenticate")).toBe(false);
    expect(supportsMcpAction(server, "remove")).toBe(false);
    expect(supportsMcpAction(server, "manage-plugin")).toBe(true);
  });
});
