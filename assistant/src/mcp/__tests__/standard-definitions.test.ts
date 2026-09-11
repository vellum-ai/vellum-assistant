import { describe, expect, test } from "bun:test";

import { Ajv2020 } from "ajv/dist/2020.js";

import {
  parseStandardDefinitions,
  STANDARD_MCP_SCHEMA_URL,
  STANDARD_PLUGIN_SCHEMA_URL,
  standardDefinitionDigest,
  type StandardMcpDocument,
  standardMcpServerSchema,
  standardPluginManifestSchema,
} from "../standard-definitions.js";
import mcpSchema from "./fixtures/agent-plugins-1.0.0/mcp.schema.json" with { type: "json" };
import pluginSchema from "./fixtures/agent-plugins-1.0.0/plugin.schema.json" with { type: "json" };

const plugin = { $schema: STANDARD_PLUGIN_SCHEMA_URL, name: "example" };
const remote = {
  type: "streamable-http" as const,
  url: "https://api.example.com/mcp",
};
const mcp = (servers: Record<string, unknown>): StandardMcpDocument => ({
  $schema: STANDARD_MCP_SCHEMA_URL,
  mcpServers: servers,
});

describe("standard catalog definitions", () => {
  test("preserves standard fields without resolving placeholders or connecting", () => {
    const server = {
      ...remote,
      url: "https://api.example.com/mcp?tenant=example",
      headers: { "X-Public-Label": "${EXAMPLE_LITERAL}" },
    };
    const result = parseStandardDefinitions(
      { ...plugin, version: "release-label", homepage: "opaque metadata" },
      mcp({ example: server }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("Expected valid catalog documents");
    }
    expect(result.servers.example).toEqual(server);
    expect(result.documents.mcp).toEqual(mcp({ example: server }));
    expect(result.documents.plugin.version).toBe("release-label");
    expect(result.issues).toEqual([]);
    expect(standardDefinitionDigest(result.documents)).toHaveLength(64);
  });

  test.each([
    { ...plugin, $schema: "https://example.com/plugin.schema.json" },
    { ...plugin, name: "Uppercase" },
    { ...plugin, name: "two--hyphens" },
    { ...plugin, author: { company: "example" } },
    { ...plugin, version: 1 },
  ])("rejects invalid core manifests without a legacy fallback", (input) => {
    const result = parseStandardDefinitions(input, mcp({ example: remote }));
    expect(result.ok).toBe(false);
    expect(result.issues.at(-1)?.code).toBe("invalid_plugin");
  });

  test("applies normative manifest failure boundaries and ignores unknown extensions", () => {
    const result = parseStandardDefinitions({
      ...plugin,
      unexpected: "ignored",
      extensions: [],
    });
    expect(result.ok).toBe(true);
    expect(result.issues.map((issue) => issue.code)).toEqual([
      "ignored_manifest_field",
      "ignored_extensions",
    ]);
    const opaque = parseStandardDefinitions({
      ...plugin,
      extensions: { "com.example.client": "opaque to this client" },
    });
    expect(opaque.ok).toBe(true);
  });

  test("isolates invalid and unsupported siblings while preserving reviewed documents", () => {
    const input = mcp({
      example: remote,
      malformed: { type: "http", url: remote.url },
      local: {
        type: "stdio",
        command: "node",
        args: ["${PLUGIN_ROOT}/server.js"],
      },
      events: { type: "sse", url: "https://api.example.com/sse" },
    });
    const result = parseStandardDefinitions(plugin, input);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("Expected valid component envelope");
    }
    expect(Object.keys(result.servers)).toEqual(["example"]);
    expect(result.documents.mcp).toEqual(input);
    expect(result.issues.map((issue) => [issue.serverKey, issue.code])).toEqual(
      [
        ["malformed", "invalid_server"],
        ["local", "unsupported_transport"],
        ["events", "unsupported_transport"],
      ],
    );
  });

  const invalidMcpDocuments: unknown[] = [
    { mcpServers: { example: remote } },
    {
      ...mcp({ example: remote }),
      $schema: "https://agent-plugins.org/schemas/2.0.0/mcp.schema.json",
    },
    { ...mcp({ example: remote }), extra: true },
    { $schema: STANDARD_MCP_SCHEMA_URL, mcpServers: [] },
  ];
  test.each(invalidMcpDocuments)(
    "rejects invalid MCP component envelopes",
    (input) => {
      const result = parseStandardDefinitions(plugin, input);
      expect(Boolean(result.ok)).toBe(false);
    },
  );

  test.each([
    "http://api.example.com/mcp",
    "https://user@example.com/mcp",
    "https://@api.example.com/mcp",
    "https://api.example.com/mcp#fragment",
    "https://api.example.com/mcp#",
    "file:///tmp/mcp",
    "/mcp",
    "https://",
    " https://api.example.com/mcp",
    "https://api.example.com/\nmcp",
    "https://api.example.com\\mcp",
  ])("rejects an invalid remote URL: %s", (url) => {
    expect(standardMcpServerSchema.safeParse({ ...remote, url }).success).toBe(
      false,
    );
  });

  test.each([
    "http://localhost/mcp",
    "http://127.0.0.2/mcp",
    "http://[::1]/mcp",
  ])("allows standard loopback HTTP: %s", (url) => {
    expect(standardMcpServerSchema.safeParse({ ...remote, url }).success).toBe(
      true,
    );
  });

  test.each([
    { "X-Tenant": "example", "x-tenant": "duplicate" },
    { "Bad Name": "example" },
    { "X-Tenant": "line\r\nbreak" },
  ])("rejects invalid HTTP headers", (headers) => {
    expect(
      standardMcpServerSchema.safeParse({ ...remote, headers }).success,
    ).toBe(false);
  });

  test("local shape rules agree with the vendored official schemas on closed core fields", () => {
    const ajv = new Ajv2020();
    const validatePlugin = ajv.compile(pluginSchema);
    const validateMcp = ajv.compile(mcpSchema);
    for (const candidate of [
      plugin,
      { ...plugin, version: "preview" },
      { ...plugin, name: "bad..name" },
      { ...plugin, author: { extra: true } },
    ]) {
      expect(standardPluginManifestSchema.safeParse(candidate).success).toBe(
        validatePlugin(candidate),
      );
    }
    for (const server of [
      remote,
      { ...remote, command: "node" },
      { ...remote, type: "http" },
      { ...remote, type: undefined },
      { ...remote, headers: { "X-Tenant": 1 } },
    ]) {
      expect(standardMcpServerSchema.safeParse(server).success).toBe(
        validateMcp(mcp({ example: server })),
      );
    }
  });
});
