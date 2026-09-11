import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { McpConfigSchema } from "../config/schemas/mcp.js";
import { WORKSPACE_MIGRATIONS } from "../workspace/migrations/registry.js";

const migration = WORKSPACE_MIGRATIONS.find(
  (entry) => entry.id === "155-mcp-catalog-provenance",
);
if (!migration) {
  throw new Error("MCP catalog provenance migration is not registered");
}

describe("catalog provenance migration", () => {
  test("preserves legacy IDs/transports and existing provenance on repeated runs", () => {
    const workspace = mkdtempSync(join(tmpdir(), "mcp-provenance-"));
    const configPath = join(workspace, "config.json");
    const legacy = {
      transport: {
        type: "sse" as const,
        url: "https://example.com/mcp",
        headers: { "X-Example": "example-value" },
      },
    };
    const catalog = {
      transport: {
        type: "streamable-http" as const,
        url: "https://example.org/mcp",
      },
      catalog: {
        id: "example",
        serverKey: "example",
        definitionDigest: "a".repeat(64),
      },
    };
    writeFileSync(
      configPath,
      JSON.stringify({
        mcp: {
          servers: { "existing-id": legacy, "catalog-instance": catalog },
        },
      }),
    );
    migration.run(workspace);
    const once = readFileSync(configPath, "utf8");
    migration.run(workspace);
    expect(readFileSync(configPath, "utf8")).toBe(once);
    const mcp = McpConfigSchema.parse(JSON.parse(once).mcp);
    expect(mcp.servers["existing-id"]).toEqual({ ...legacy, catalog: null });
    expect(mcp.servers["catalog-instance"]).toEqual(catalog);
    expect(Object.keys(mcp.servers)).toEqual([
      "existing-id",
      "catalog-instance",
    ]);
  });

  test("does not change an absent or malformed configuration", () => {
    const workspace = mkdtempSync(join(tmpdir(), "mcp-provenance-"));
    expect(() => migration.run(workspace)).not.toThrow();
    const configPath = join(workspace, "config.json");
    writeFileSync(configPath, "{invalid");
    migration.run(workspace);
    expect(readFileSync(configPath, "utf8")).toBe("{invalid");
  });

  test.skipIf(process.platform === "win32")(
    "preserves config permissions when retrying an interrupted temporary write",
    () => {
      const workspace = mkdtempSync(join(tmpdir(), "mcp-provenance-mode-"));
      const configPath = join(workspace, "config.json");
      writeFileSync(
        configPath,
        JSON.stringify({
          mcp: {
            servers: {
              example: {
                transport: { type: "sse", url: "https://example.com/mcp" },
              },
            },
          },
        }),
      );
      chmodSync(configPath, 0o600);
      const temporary = `${configPath}.migration-155.tmp`;
      writeFileSync(temporary, "interrupted write");
      chmodSync(temporary, 0o644);
      migration.run(workspace);
      expect(statSync(configPath).mode & 0o777).toBe(0o600);
      expect(
        JSON.parse(readFileSync(configPath, "utf8")).mcp.servers.example
          .catalog,
      ).toBeNull();
    },
  );
});
