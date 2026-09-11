import { beforeEach, describe, expect, mock, test } from "bun:test";

const entries = [{ id: "example", serverKey: "primary" }];
const list = mock(() => entries);
const connect = mock(async (_request: unknown) => ({
  serverId: "catalog-instance",
  created: true,
}));
mock.module("../../../mcp/catalog.js", () => ({ getMcpCatalog: list }));
mock.module("../../../mcp/catalog-connections.js", () => ({
  connectMcpCatalogEntry: connect,
}));
const { ROUTES } = await import("../mcp-catalog-routes.js");
const { BadRequestError } = await import("../errors.js");
const readRoute = ROUTES.find(
  (route) => route.operationId === "internal_mcp_catalog",
)!;
const connectRoute = ROUTES.find(
  (route) => route.operationId === "internal_mcp_catalog_connect",
)!;
const request = {
  catalogId: "example",
  serverKey: "primary",
  definitionDigest: "a".repeat(64),
};

beforeEach(() => {
  list.mockClear();
  connect.mockClear();
});

describe("MCP catalog route contracts", () => {
  test("catalog reads expose capability without creating connections", async () => {
    expect(readRoute.method).toBe("GET");
    expect(await readRoute.handler({})).toEqual({
      supportsConnect: true,
      entries,
    });
    expect(list).toHaveBeenCalledTimes(1);
    expect(connect).not.toHaveBeenCalled();
    expect(readRoute.policy?.requiredScopes).toEqual(["settings.read"]);
  });

  test("connecting requires settings-write policy and forwards only declared request fields", async () => {
    expect(connectRoute.method).toBe("POST");
    expect(connectRoute.policy?.requiredScopes).toEqual(["settings.write"]);
    expect(
      await connectRoute.handler({
        body: { ...request, setupAcknowledged: true },
      }),
    ).toEqual({
      serverId: "catalog-instance",
      created: true,
    });
    expect(connect).toHaveBeenCalledWith({
      ...request,
      setupAcknowledged: true,
    });
  });

  test.each([
    { url: "https://replacement.example.com/mcp" },
    { transport: { type: "stdio", command: "example-command" } },
    { source: "plugin" },
    { serverId: "existing-user-connection" },
  ])(
    "rejects identity or endpoint overrides before calling connect: %j",
    async (override) => {
      await expect(
        Promise.resolve().then(() =>
          connectRoute.handler({ body: { ...request, ...override } }),
        ),
      ).rejects.toThrow(BadRequestError);
      expect(connect).not.toHaveBeenCalled();
    },
  );

  test.each([
    { ...request, definitionDigest: "stale" },
    { ...request, catalogId: "" },
    { ...request, serverKey: "" },
  ])("rejects malformed catalog selections before writes: %j", async (body) => {
    await expect(
      Promise.resolve().then(() => connectRoute.handler({ body })),
    ).rejects.toThrow(BadRequestError);
    expect(connect).not.toHaveBeenCalled();
  });
});
