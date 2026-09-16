import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import { buildBundledPluginPackages } from "../../../assistant/scripts/bundled-plugin-packages.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function fixture(path = "plugins/mcp-catalog/fathom"): string {
  const root = mkdtempSync(join(tmpdir(), "bundled-plugin-packages-"));
  roots.push(root);
  const packageRoot = join(root, "plugins", "mcp-catalog", "fathom");
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(
    join(packageRoot, "plugin.json"),
    JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      name: "fathom",
      version: "1.0.0",
    }),
  );
  writeFileSync(
    join(packageRoot, "mcp.json"),
    JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
      mcpServers: {
        fathom: {
          type: "streamable-http",
          url: "https://api.fathom.ai/mcp",
        },
      },
    }),
  );
  writeFileSync(
    join(root, "plugins", "marketplace.json"),
    JSON.stringify({
      plugins: [
        {
          name: "fathom",
          source: { source: "local", path, version: "1.0.0" },
        },
      ],
    }),
  );
  return root;
}

describe("buildBundledPluginPackages", () => {
  test("embeds a valid standard MCP package", () => {
    const packages = buildBundledPluginPackages(fixture());
    expect(packages["plugins/mcp-catalog/fathom"]).toMatchObject({
      version: "1.0.0",
      files: [
        { path: "mcp.json", contentBase64: expect.any(String) },
        { path: "plugin.json", contentBase64: expect.any(String) },
      ],
    });
  });

  test.each(["plugins/mcp-catalog/../fathom", "plugins/mcp-catalog/./fathom"])(
    "rejects a noncanonical package key: %s",
    (path) => {
      expect(() => buildBundledPluginPackages(fixture(path))).toThrow(
        /not canonical/,
      );
    },
  );

  test("rejects a symlink at the declared package root", () => {
    const root = fixture("plugins/mcp-catalog/fathom-link");
    symlinkSync(
      join(root, "plugins", "mcp-catalog", "fathom"),
      join(root, "plugins", "mcp-catalog", "fathom-link"),
    );
    expect(() => buildBundledPluginPackages(root)).toThrow(/symlinks/);
  });

  test("rejects a symlink in a declared package ancestor", () => {
    const root = fixture("plugins/alias/fathom");
    symlinkSync(
      join(root, "plugins", "mcp-catalog"),
      join(root, "plugins", "alias"),
    );
    expect(() => buildBundledPluginPackages(root)).toThrow(/symlinks/);
  });

  test("rejects an invalid MCP server definition", () => {
    const root = fixture();
    writeFileSync(
      join(root, "plugins", "mcp-catalog", "fathom", "mcp.json"),
      JSON.stringify({
        $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
        mcpServers: { fathom: { type: "streamable-http" } },
      }),
    );
    expect(() => buildBundledPluginPackages(root)).toThrow();
  });
});
