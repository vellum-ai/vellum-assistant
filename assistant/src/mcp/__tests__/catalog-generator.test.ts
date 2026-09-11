import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";

import { buildMcpCatalog, generateMcpCatalog } from "../catalog-generator.js";
import { mcpCatalogIndexSchema } from "../catalog-schema.js";
import {
  STANDARD_MCP_SCHEMA_URL,
  STANDARD_PLUGIN_SCHEMA_URL,
} from "../standard-definitions.js";

const root = await mkdtemp(join(tmpdir(), "vellum-catalog-generator-"));
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});
let sequence = 0;
const entry = {
  id: "example",
  packagePath: "plugins/example",
  serverKey: "example",
  source: { kind: "local" },
  displayName: "Example",
  description: "Search records.",
  documentationUrl: "https://docs.example.com/mcp",
  verifiedAt: "2026-09-10",
  verification: "documentation-only",
  setup: { mode: "oauth" },
};

async function fixture(entries: unknown[] = [entry]): Promise<string> {
  const dir = join(root, `repo-${++sequence}`);
  await mkdir(join(dir, "plugins/example"), { recursive: true });
  await mkdir(join(dir, "assistant/src/mcp"), { recursive: true });
  await writeFile(
    join(dir, "plugins/mcp-catalog.json"),
    JSON.stringify({ version: 1, entries }),
  );
  await writeFile(
    join(dir, "plugins/example/plugin.json"),
    JSON.stringify({ $schema: STANDARD_PLUGIN_SCHEMA_URL, name: "example" }),
  );
  await writeFile(
    join(dir, "plugins/example/mcp.json"),
    JSON.stringify({
      $schema: STANDARD_MCP_SCHEMA_URL,
      mcpServers: {
        example: {
          type: "streamable-http",
          url: "https://api.example.com/mcp",
          headers: { "X-Public-Tenant": "example" },
        },
      },
    }),
  );
  return dir;
}

describe("MCP catalog generation", () => {
  test("produces deterministic standard documents and detects drift without rewriting", async () => {
    const dir = await fixture();
    await generateMcpCatalog(dir, false);
    const output = join(dir, "assistant/src/mcp/bundled-catalog.json");
    const original = await readFile(output, "utf8");
    await generateMcpCatalog(dir, false);
    expect(await readFile(output, "utf8")).toBe(original);
    await generateMcpCatalog(dir, true);
    const { catalog } = await buildMcpCatalog(dir);
    expect(catalog.entries[0]?.documents.mcp?.mcpServers.example).toEqual({
      type: "streamable-http",
      url: "https://api.example.com/mcp",
      headers: { "X-Public-Tenant": "example" },
    });
    expect(catalog.entries[0]).not.toHaveProperty("url");
    await writeFile(output, "{}\n");
    await expect(generateMcpCatalog(dir, true)).rejects.toThrow("stale");
    expect(await readFile(output, "utf8")).toBe("{}\n");
  });

  test.each([
    { entries: [entry, entry] },
    { entries: [{ ...entry, packagePath: "../escape" }] },
    { entries: [{ ...entry, packagePath: "/absolute" }] },
    {
      entries: [
        {
          ...entry,
          source: {
            kind: "github",
            repository: {
              source: "github",
              repo: "example/plugin",
              ref: "main",
            },
            definitionDigest: "a".repeat(64),
          },
        },
      ],
    },
  ])("rejects invalid curation identity and pins", ({ entries }) => {
    expect(
      mcpCatalogIndexSchema.safeParse({ version: 1, entries }).success,
    ).toBe(false);
  });

  test("fails an advertised item without a usable standard definition", async () => {
    const dir = await fixture([{ ...entry, serverKey: "missing" }]);
    await expect(buildMcpCatalog(dir)).rejects.toThrow(
      "no usable standard server",
    );
  });

  test("reuses marketplace pins and verifies reviewed upstream document digests", async () => {
    const dir = await fixture();
    const first = (await buildMcpCatalog(dir)).catalog.entries[0]!;
    const source = {
      source: "github" as const,
      repo: "example/provider",
      ref: "a".repeat(40),
    };
    await writeFile(
      join(dir, "plugins/marketplace.json"),
      JSON.stringify({
        name: "example",
        plugins: [{ name: "example", source }],
      }),
    );
    await writeFile(
      join(dir, "plugins/mcp-catalog.json"),
      JSON.stringify({
        version: 1,
        entries: [
          {
            ...entry,
            source: {
              kind: "marketplace",
              name: "example",
              definitionDigest: first.definitionDigest,
            },
          },
        ],
      }),
    );
    expect(
      (await buildMcpCatalog(dir)).catalog.entries[0]?.resolvedSource,
    ).toEqual(source);
    await writeFile(
      join(dir, "plugins/example/plugin.json"),
      JSON.stringify({
        $schema: STANDARD_PLUGIN_SCHEMA_URL,
        name: "different",
      }),
    );
    await expect(buildMcpCatalog(dir)).rejects.toThrow(
      "reviewed source digest",
    );
  });
});
