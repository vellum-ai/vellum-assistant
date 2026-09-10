import { mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, mock, test } from "bun:test";

import { makeMockLogger } from "./helpers/mock-logger.js";

mock.module("../util/logger.js", () => ({
  LOG_FILE_PATTERN: /^assistant-(\d{4}-\d{2}-\d{2})\.log$/,
  getCliLogger: () => makeMockLogger(),
  getLogger: () => makeMockLogger(),
  initLogger: () => {},
  pruneOldLogFiles: () => 0,
  getCurrentLogFilePath: () => "/tmp/test-assistant.log",
  truncateForLog: (value: string, maxLen = 500) => value.slice(0, maxLen),
}));

let rawConfig: Record<string, unknown> = {};
let seededRawText = "";
let mtimeSeq = 0;

function configJsonPath(): string {
  return join(process.env.VELLUM_WORKSPACE_DIR!, "config.json");
}

function mcpJsonPath(): string {
  return join(process.env.VELLUM_WORKSPACE_DIR!, "mcp.json");
}

function seedRawConfig(raw: Record<string, unknown>): void {
  rawConfig = raw;
  seededRawText = JSON.stringify(raw);
  mkdirSync(process.env.VELLUM_WORKSPACE_DIR!, { recursive: true });
  writeFileSync(configJsonPath(), seededRawText);
  mtimeSeq += 1;
  const stamp = new Date(Date.now() + mtimeSeq);
  utimesSync(configJsonPath(), stamp, stamp);
}

function seedWorkspaceMcp(document: unknown): void {
  writeFileSync(mcpJsonPath(), JSON.stringify(document, null, 2) + "\n");
}

function committedRaw(): Record<string, unknown> | null {
  const text = readFileSync(configJsonPath(), "utf8");
  if (text === seededRawText) {
    return null;
  }
  return JSON.parse(text) as Record<string, unknown>;
}

mock.module("../daemon/config-watcher.js", () => ({
  getConfigWatcher: () => ({
    suppressConfigReload: false,
    timers: { schedule: () => {} },
    updateFingerprint: () => {},
  }),
}));

mock.module("../providers/registry.js", () => ({
  clearConnectionProviderCache: () => {},
  getProvider: () => {
    throw new Error("provider registry mock not implemented");
  },
  getProviderRoutingSource: () => null,
  initializeProviders: async () => {},
  isNativeWebSearchCapableProvider: () => false,
  listProviders: () => [],
  resolveProviderFromConnection: async () => null,
  shouldUseNativeWebSearch: () => false,
}));

mock.module("../persistence/embeddings/embedding-backend.js", () => ({
  isEmbeddingDimensionAvailable: async () => true,
  EmbeddingBackendUnavailableError: class EmbeddingBackendUnavailableError extends Error {},
  SPARSE_EMBEDDING_VERSION: 4,
  clearEmbeddingBackendCache: () => {},
  embedWithBackend: async () => ({
    provider: "local",
    model: "test",
    vectors: [],
  }),
  geminiCacheExtras: () => [],
  customCacheExtras: () => [],
  durableEmbeddingCacheExtras: () => [],
  generateSparseEmbedding: () => ({ indices: [], values: [] }),
  getMemoryBackendStatus: async () => ({
    enabled: false,
    provider: null,
    model: null,
  }),
  resetLocalEmbeddingFailureState: () => {},
  resolveBackendDimension: async () => null,
  selectEmbeddingBackend: async () => null,
  selectedBackendSupportsMultimodal: async () => false,
}));

mock.module("../security/secret-allowlist.js", () => ({
  isAllowlisted: () => false,
  loadAllowlist: () => {},
  resetAllowlist: () => {},
  validateAllowlistFile: () => null,
}));

const { ROUTES } =
  await import("../runtime/routes/conversation-query-routes.js");
const { BadRequestError } = await import("../runtime/routes/errors.js");

function findRoute(operationId: string) {
  const route = ROUTES.find((r) => r.operationId === operationId);
  if (!route) {
    throw new Error(`Route not found: ${operationId}`);
  }
  return route;
}

const configGetRoute = findRoute("config_get");
const configPatchRoute = findRoute("config_patch");
const configSetRoute = findRoute("config_set");

function withoutWireProfiles(
  result: Record<string, unknown>,
): Record<string, unknown> {
  const { llm: _llm, ...rest } = result;
  return rest;
}

describe("MCP config secret boundary", () => {
  beforeEach(() => {
    seedRawConfig({});
    rmSync(mcpJsonPath(), { force: true });
  });

  test("config_get omits MCP headers from the mcp.json overlay", () => {
    seedWorkspaceMcp({
      mcpServers: {
        remote: {
          type: "streamable-http",
          url: "https://mcp.example.com",
          headers: {
            Authorization: "Bearer mcp-secret",
            "X-API-Key": "mcp-api-secret",
          },
        },
      },
    });

    const result = configGetRoute.handler({}) as Record<string, unknown>;

    expect(JSON.stringify(result)).not.toContain("mcp-secret");
    expect(JSON.stringify(result)).not.toContain("mcp-api-secret");
    const mcp = result.mcp as {
      servers: { remote: { transport: Record<string, unknown> } };
    };
    expect(mcp.servers.remote.transport).toEqual({
      type: "streamable-http",
      url: "https://mcp.example.com",
    });
  });

  test("config_get ignores leftover config.json mcp so its headers cannot leak", () => {
    seedRawConfig({
      mcp: {
        servers: {
          remote: {
            transport: {
              type: "streamable-http",
              url: "https://mcp.example.com",
              headers: { Authorization: "Bearer leftover-secret" },
            },
          },
        },
      },
    });

    const result = configGetRoute.handler({}) as Record<string, unknown>;

    expect(JSON.stringify(result)).not.toContain("leftover-secret");
    expect(
      (result.mcp as { servers: Record<string, unknown> }).servers,
    ).toEqual({});
  });

  test("config_get preserves an MCP server named headers", () => {
    seedWorkspaceMcp({
      mcpServers: {
        headers: {
          type: "streamable-http",
          url: "https://mcp.example.com",
        },
      },
    });

    const result = configGetRoute.handler({}) as Record<string, unknown>;

    expect(withoutWireProfiles(result).mcp).toEqual({
      servers: {
        headers: {
          transport: {
            type: "streamable-http",
            url: "https://mcp.example.com",
          },
        },
      },
    });
  });

  test("config_get preserves non-credential headers env vars", () => {
    seedWorkspaceMcp({
      mcpServers: {
        local: {
          type: "stdio",
          command: "npx",
          env: {
            headers: "not-a-transport-header",
          },
        },
      },
    });

    const result = configGetRoute.handler({}) as Record<string, unknown>;

    expect(withoutWireProfiles(result).mcp).toEqual({
      servers: {
        local: {
          transport: {
            type: "stdio",
            command: "npx",
            args: [],
            env: {
              headers: "not-a-transport-header",
            },
          },
        },
      },
    });
  });

  test("config_patch rejects MCP transport headers so generic writes cannot reintroduce plaintext credentials", async () => {
    await expect(
      configPatchRoute.handler({
        body: {
          mcp: {
            servers: {
              remote: {
                transport: {
                  type: "streamable-http",
                  url: "https://mcp.example.com",
                  headers: { Authorization: "Bearer mcp-secret" },
                },
              },
            },
          },
        },
      }),
    ).rejects.toThrow(BadRequestError);
    expect(committedRaw()).toBeNull();
  });

  test("config_patch strips mcp so a full-config round trip cannot write it back", async () => {
    const result = await configPatchRoute.handler({
      body: {
        mcp: {
          servers: {
            headers: {
              transport: {
                type: "streamable-http",
                url: "https://mcp.example.com",
              },
            },
          },
        },
      },
    });

    expect(committedRaw()?.mcp).toBeUndefined();
    expect(
      (result as { mcp: { servers: Record<string, unknown> } }).mcp.servers,
    ).toEqual({});
  });

  test("config_set rejects MCP server writes", async () => {
    await expect(
      configSetRoute.handler({
        body: {
          path: "mcp.servers",
          value: {
            remote: {
              transport: {
                type: "streamable-http",
                url: "https://mcp.example.com",
              },
            },
          },
        },
      }),
    ).rejects.toThrow(BadRequestError);
    expect(committedRaw()).toBeNull();
  });

  test("config_set rejects direct MCP transport header paths", async () => {
    await expect(
      configSetRoute.handler({
        body: {
          path: "mcp.servers.remote.transport.headers.Authorization",
          value: "Bearer mcp-secret",
        },
      }),
    ).rejects.toThrow(BadRequestError);
    expect(committedRaw()).toBeNull();
  });
});
