import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";

import { readPluginMcpServers } from "../../plugins/mcp-servers.js";
import { snapshotPluginSource } from "../../plugins/source-fingerprint.js";
import { readStandardCatalogPackage } from "../catalog-manifests.js";
import {
  STANDARD_MCP_SCHEMA_URL,
  STANDARD_PLUGIN_SCHEMA_URL,
} from "../standard-definitions.js";

const root = await mkdtemp(join(tmpdir(), "vellum-standard-catalog-"));
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});
let sequence = 0;
const plugin = { $schema: STANDARD_PLUGIN_SCHEMA_URL, name: "example" };
const mcp = {
  $schema: STANDARD_MCP_SCHEMA_URL,
  mcpServers: {
    example: { type: "streamable-http", url: "https://api.example.com/mcp" },
  },
};

async function packageDirectory(): Promise<string> {
  const dir = join(root, `package-${++sequence}`);
  await mkdir(dir);
  await writeFile(join(dir, "plugin.json"), JSON.stringify(plugin));
  return dir;
}

describe("catalog package reads", () => {
  test("reads only standard data and accepts a missing optional MCP component", async () => {
    const dir = await packageDirectory();
    expect((await readStandardCatalogPackage(dir)).ok).toBe(true);
    await writeFile(join(dir, "mcp.json"), JSON.stringify(mcp));
    await writeFile(
      join(dir, "index.ts"),
      "throw new Error('must not execute');",
    );
    const result = await readStandardCatalogPackage(dir, root);
    expect(result.ok && result.servers.example?.url).toBe(
      "https://api.example.com/mcp",
    );
  });

  test.each(["plugin.json", "mcp.json"] as const)(
    "rejects an escaping %s symlink",
    async (filename) => {
      const dir = await packageDirectory();
      const outside = join(root, `outside-${++sequence}.json`);
      await writeFile(
        outside,
        JSON.stringify(filename === "plugin.json" ? plugin : mcp),
      );
      if (filename === "plugin.json") {
        await rm(join(dir, filename));
      }
      await symlink(outside, join(dir, filename));
      const result = await readStandardCatalogPackage(dir);
      expect(result.ok).toBe(false);
      expect(result.issues[0]?.code).toBe("path_escape");
    },
  );

  test("rejects a package symlink outside the reviewed source boundary", async () => {
    const dir = await packageDirectory();
    const boundary = await packageDirectory();
    await symlink(dir, join(boundary, "outside"));
    expect(
      (await readStandardCatalogPackage(join(boundary, "outside"), boundary))
        .issues[0]?.code,
    ).toBe("path_escape");
  });

  test("rejects invalid JSON, directories, and oversized document files", async () => {
    const dir = await packageDirectory();
    await writeFile(join(dir, "mcp.json"), "{");
    expect((await readStandardCatalogPackage(dir)).issues[0]?.code).toBe(
      "invalid_json",
    );
    await writeFile(join(dir, "mcp.json"), " ".repeat(1024 * 1024 + 1));
    expect((await readStandardCatalogPackage(dir)).issues[0]?.code).toBe(
      "read_error",
    );
    await rm(join(dir, "mcp.json"));
    await mkdir(join(dir, "mcp.json"));
    expect((await readStandardCatalogPackage(dir)).issues[0]?.code).toBe(
      "read_error",
    );
  });

  test("catalog reads leave existing plugin identities, state, and fingerprints intact", async () => {
    const pluginsDir = join(root, "installed");
    const installed = join(pluginsDir, "legacy-example");
    await mkdir(join(installed, "hooks"), { recursive: true });
    await mkdir(join(installed, "skills", "example"), { recursive: true });
    await mkdir(join(installed, "data"));
    const files = {
      "package.json": JSON.stringify({
        name: "legacy-example",
        version: "1.0.0",
      }),
      "plugin.json": JSON.stringify({
        name: "legacy-example",
        hooks: "./hooks",
      }),
      "mcp.json": JSON.stringify({
        mcpServers: {
          example: { type: "http", url: "https://legacy.example.com/mcp" },
        },
      }),
      "hooks/stop.ts": "export default () => undefined;",
      "skills/example/SKILL.md":
        "---\nname: example\ndescription: Example skill\n---\nExample.",
      "data/state.json": JSON.stringify({ count: 7 }),
      "install-meta.json": JSON.stringify({
        source: "example",
        ref: "a".repeat(40),
      }),
    };
    for (const [name, content] of Object.entries(files)) {
      await writeFile(join(installed, name), content);
    }
    const before = snapshotPluginSource(installed);
    const legacyBefore = readPluginMcpServers({
      workspacePluginsDir: pluginsDir,
    });
    const catalog = await packageDirectory();
    await writeFile(join(catalog, "mcp.json"), JSON.stringify(mcp));
    expect((await readStandardCatalogPackage(catalog)).ok).toBe(true);
    expect((await readStandardCatalogPackage(installed)).ok).toBe(false);
    await writeFile(join(catalog, "plugin.json"), "{}");
    expect((await readStandardCatalogPackage(catalog)).ok).toBe(false);
    expect(snapshotPluginSource(installed)).toEqual(before);
    expect(readPluginMcpServers({ workspacePluginsDir: pluginsDir })).toEqual(
      legacyBefore,
    );
    expect(legacyBefore.servers.map((server) => server.id)).toContain(
      "legacy-example__example",
    );
    for (const [name, content] of Object.entries(files)) {
      expect(await readFile(join(installed, name), "utf8")).toBe(content);
    }
  });
});
