import { beforeEach, expect, mock, test } from "bun:test";

let result: { data?: unknown; response: Response };
const get = mock(async (_args: unknown) => result);
const post = mock(async (_args: unknown) => result);
mock.module("@/generated/daemon/client.gen", () => ({ client: { get, post } }));
const { fetchMcpCatalog, connectMcpCatalogEntry } = await import("./mcp-catalog-api");

beforeEach(() => {
  get.mockClear();
  post.mockClear();
});

test("old assistants expose no catalog write capability", async () => {
  result = { response: new Response(null, { status: 404 }) };
  expect(await fetchMcpCatalog("assistant-1")).toEqual({ supportsConnect: false, entries: [] });
  expect(post).not.toHaveBeenCalled();
});

test("capability must be explicitly advertised and outages stay errors", async () => {
  result = { data: { entries: [] }, response: new Response() };
  expect((await fetchMcpCatalog("assistant-1")).supportsConnect).toBe(false);
  result = { data: { entries: [], supportsConnect: true }, response: new Response() };
  expect((await fetchMcpCatalog("assistant-1")).supportsConnect).toBe(true);
  result = { response: new Response(null, { status: 503 }) };
  await expect(fetchMcpCatalog("assistant-1")).rejects.toThrow("503");
});

test("connect passes reviewed identity and returns the saved instance", async () => {
  result = { data: { serverId: "saved-instance", created: false }, response: new Response() };
  const body = { catalogId: "example", serverKey: "example", definitionDigest: "a".repeat(64) };
  expect(await connectMcpCatalogEntry("assistant-1", body)).toEqual({ serverId: "saved-instance", created: false });
  expect(post).toHaveBeenCalledWith({
    url: "/v1/assistants/{assistant_id}/internal/mcp/catalog/connect",
    path: { assistant_id: "assistant-1" },
    body,
  });
});
