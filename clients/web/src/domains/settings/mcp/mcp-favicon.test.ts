import { describe, expect, test } from "bun:test";

import { getMcpFaviconUrl } from "./mcp-favicon";

describe("MCP favicon origins", () => {
  test("drops endpoint paths, query strings, and fragments", () => {
    expect(
      getMcpFaviconUrl(
        "https://api.example.com:8443/mcp/account?token=example#details",
      ),
    ).toBe("https://api.example.com:8443/favicon.ico");
  });

  test.each([
    undefined,
    "",
    "not a url",
    "/mcp",
    "http://api.example.com/mcp",
    "file:///tmp/mcp",
    "https://user:password@api.example.com/mcp",
    "https://localhost/mcp",
    "https://LOCALHOST./mcp",
    "https://host.localhost/mcp",
    "https://host.local/mcp",
    "https://host.internal/mcp",
    "https://host.home.arpa/mcp",
    "https://home.arpa/mcp",
    "https://host.ts.net/mcp",
    "https://host.lan/mcp",
    "https://intranet/mcp",
    "https://127.0.0.1/mcp",
    "https://192.168.1.2/mcp",
    "https://10.0.0.1/mcp",
    "https://100.64.0.1/mcp",
    "https://172.16.0.1/mcp",
    "https://169.254.169.254/mcp",
    "https://2130706433/mcp",
    "https://[::1]/mcp",
    "https://[::ffff:127.0.0.1]/mcp",
    "https://[fd00::1]/mcp",
    "https://[fe80::1]/mcp",
    "https://api.example.com\\mcp",
    " https://api.example.com/mcp",
  ])("uses a generic icon for an unsupported or private origin: %s", (url) => {
    expect(getMcpFaviconUrl(url)).toBeNull();
  });
});
