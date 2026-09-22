import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";

import {
  mcpOAuthCredentialKey,
  pluginMcpOAuthCredentialPrefix,
  pluginMcpOAuthCredentialTarget,
  workspaceMcpOAuthCredentialTarget,
} from "../credential-target.js";

describe("MCP OAuth credential identity", () => {
  test("keeps workspace credential keys unchanged", () => {
    expect(
      mcpOAuthCredentialKey(
        workspaceMcpOAuthCredentialTarget("server-1"),
        "tokens",
      ),
    ).toBe("mcp:server-1:tokens");
  });

  test("isolates plugin credentials by owner, original key, transport, and URL", () => {
    const target = pluginMcpOAuthCredentialTarget("plugin/name", "server:key", {
      type: "streamable-http",
      url: "https://example.com/mcp?b=2&a=1#ignored",
    });
    const digest = createHash("sha256")
      .update("streamable-http\nhttps://example.com/mcp?b=2&a=1")
      .digest("hex");

    expect(mcpOAuthCredentialKey(target, "tokens")).toBe(
      `mcp-plugin/v1/cGx1Z2luL25hbWU/c2VydmVyOmtleQ/${digest}/tokens`,
    );
  });

  test("keeps query order and path changes isolated while ignoring fragments", () => {
    const key = (url: string) =>
      mcpOAuthCredentialKey(
        pluginMcpOAuthCredentialTarget("plugin", "server", {
          type: "sse",
          url,
        }),
        "tokens",
      );

    expect(key("https://example.com/a?b=2&a=1#one")).toBe(
      key("https://example.com/a?b=2&a=1#two"),
    );
    expect(key("https://example.com/a?b=2&a=1")).not.toBe(
      key("https://example.com/a?a=1&b=2"),
    );
    expect(key("https://example.com/a")).not.toBe(key("https://example.com/b"));
  });

  test("builds a slash-delimited whole-plugin cleanup prefix", () => {
    expect(pluginMcpOAuthCredentialPrefix("plugin/name")).toBe(
      "mcp-plugin/v1/cGx1Z2luL25hbWU/",
    );
  });
});
