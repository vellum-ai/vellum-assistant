import { expect, test } from "bun:test";
import type { GatewayConfig } from "../config.js";
import { createDesktopBrowserHandler } from "../http/routes/desktop-browser.js";

function fixture() {
  const forwarded: Request[] = [];
  const handler = createDesktopBrowserHandler(
    {
      assistantRuntimeBaseUrl: "http://runtime.example.com",
      maxWebhookPayloadBytes: 1024,
    } as GatewayConfig,
    {
      fetch: async (input, init) => {
        const req = new Request(input, init);
        forwarded.push(req);
        return Response.json({ connected: true });
      },
      guardian: async () => "user-123",
      serviceToken: () => "test-service-token",
      acceptsCapability: (token: unknown) => token === "capability",
    },
  );
  const request = (body: string, origin?: string) =>
    new Request("http://gateway.example.com/v1/desktop/browser/bridge", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(origin ? { Origin: origin } : {}),
      },
      body,
    });
  return { forwarded, handler, request };
}

test("native desktop bridge stamps the bound guardian and service identity", async () => {
  const f = fixture();
  const response = await f.handler(
    f.request(
      JSON.stringify({
        token: "capability",
        guardian: "user-other",
        kind: "connect",
      }),
    ),
  );
  expect(response.status).toBe(200);
  expect(f.forwarded[0]?.headers.get("authorization")).toBe(
    "Bearer test-service-token",
  );
  expect((await f.forwarded[0]!.json()).guardian).toBe("user-123");
});

test("browser callers and oversized messages cannot reach the bridge", async () => {
  const f = fixture();
  for (const origin of [
    "https://example.com",
    "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  ]) {
    expect((await f.handler(f.request("{}", origin))).status).toBe(403);
  }
  expect((await f.handler(f.request("x".repeat(1025)))).status).toBe(413);
  expect(f.forwarded).toHaveLength(0);
});

test("originless requests still require the native capability before forwarding", async () => {
  const f = fixture();
  for (const token of [undefined, "wrong", null, 123]) {
    const response = await f.handler(
      f.request(JSON.stringify({ token, kind: "connect" })),
    );
    expect(response.status).toBe(403);
  }
  expect(f.forwarded).toHaveLength(0);
});
