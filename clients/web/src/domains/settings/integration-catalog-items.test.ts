import { describe, expect, test } from "bun:test";

import {
  buildIntegrationItems,
  filterIntegrationItems,
  mcpDisplayName,
} from "./integration-items";
import {
  mcpCatalogEntry,
  mcpServer,
  oauthConnection,
  oauthProvider,
} from "./integration-test-fixtures";

const definition = mcpCatalogEntry({
  id: "notion",
  serverKey: "notion",
  displayName: "Notion",
  oauthProvider: "notion",
});
const provenance = {
  id: definition.id,
  serverKey: definition.serverKey,
  definitionDigest: definition.definitionDigest,
};

describe("catalog integration identity", () => {
  test("display names use catalog identity while custom and plugin names remain unchanged", () => {
    const saved = mcpServer({ id: "saved-notion", catalog: provenance });
    expect(mcpDisplayName(saved, [definition])).toBe("Notion");
    expect(mcpDisplayName(saved, [])).toBe("notion");
    expect(
      mcpDisplayName(mcpServer({ id: "My custom Notion" }), [definition]),
    ).toBe("My custom Notion");
    expect(mcpDisplayName({ ...saved, source: "plugin" }, [definition])).toBe(
      "saved-notion",
    );
  });
  test("joins only explicit provenance and preserves custom servers with identical names and URLs", () => {
    const saved = mcpServer({ id: "saved-notion", catalog: provenance });
    const custom = mcpServer({ id: "Notion" });
    const items = buildIntegrationItems(
      [oauthProvider()],
      [],
      [saved, custom],
      [definition],
    );
    expect(items).toHaveLength(2);
    const brand = items.find((item) => item.kind === "oauth");
    expect(
      brand?.kind === "oauth" &&
        brand.methods[0]?.servers.map((server) => server.id),
    ).toEqual(["saved-notion"]);
    expect(
      items.some((item) => item.kind === "mcp" && item.server.id === "Notion"),
    ).toBe(true);
  });

  test("disconnecting one method preserves a working OAuth account in Connected", () => {
    const accounts = [
      oauthConnection({ connected: false }),
      oauthConnection({ id: "account-2" }),
    ];
    const before = buildIntegrationItems(
      [oauthProvider()],
      accounts,
      [mcpServer({ catalog: provenance })],
      [definition],
    );
    const after = buildIntegrationItems(
      [oauthProvider()],
      accounts,
      [],
      [definition],
    );
    expect(filterIntegrationItems(before, "", "connected")).toHaveLength(1);
    expect(filterIntegrationItems(after, "", "connected")).toHaveLength(1);
    expect(filterIntegrationItems(after, "", "available")).toHaveLength(0);
  });

  test("a working MCP connection keeps a brand connected despite a failed OAuth account", () => {
    const items = buildIntegrationItems(
      [oauthProvider()],
      [oauthConnection({ connected: false })],
      [mcpServer({ catalog: provenance })],
      [definition],
    );
    expect(filterIntegrationItems(items, "", "connected")).toHaveLength(1);
  });

  test("a removed definition leaves the saved server independently manageable", () => {
    const items = buildIntegrationItems(
      [oauthProvider()],
      [],
      [mcpServer({ catalog: provenance })],
      [],
    );
    expect(
      items.some(
        (item) => item.kind === "mcp" && item.server.catalog === provenance,
      ),
    ).toBe(true);
  });

  test("catalog changes do not rekey saved instances or merge plugin ownership", () => {
    const saved = mcpServer({
      catalog: { ...provenance, definitionDigest: "b".repeat(64) },
    });
    const plugin = mcpServer({
      id: "plugin-notion",
      source: "plugin",
      catalog: provenance,
    });
    const items = buildIntegrationItems([], [], [saved, plugin], [definition]);
    expect(items.find((item) => item.kind === "catalog")?.configured).toBe(
      true,
    );
    expect(
      items.some(
        (item) => item.kind === "mcp" && item.server.id === "plugin-notion",
      ),
    ).toBe(true);
  });

  test("curated descriptions are searchable and unmapped brands remain separate", () => {
    const items = buildIntegrationItems(
      [oauthProvider()],
      [],
      [],
      [
        mcpCatalogEntry({
          displayName: "Notion",
          description: "Unique meeting summaries",
        }),
      ],
    );
    expect(items).toHaveLength(2);
    expect(filterIntegrationItems(items, "meeting", "available")).toHaveLength(
      1,
    );
  });
});
