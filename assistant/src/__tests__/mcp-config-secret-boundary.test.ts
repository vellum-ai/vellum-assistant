import { readFileSync, utimesSync, writeFileSync } from "node:fs";
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

// The config routes under test read and write the workspace config.json via
// the real loader (`loadRawConfig`/`saveRawConfig`). Tests seed the raw file
// directly (the fixtures are raw-file shapes, including deliberately
// malformed trees, so the whole file is replaced rather than composed via
// `setConfig`) and detect commits by comparing the on-disk text against the
// seeded snapshot — `saveRawConfig` pretty-prints, so any commit changes the
// text.
let rawConfig: Record<string, unknown> = {};
let seededRawText = "";
let mtimeSeq = 0;

function configJsonPath(): string {
  return join(process.env.VELLUM_WORKSPACE_DIR!, "config.json");
}

/** Write `raw` to the workspace config.json as the seeded pre-test state. */
function seedRawConfig(raw: Record<string, unknown>): void {
  rawConfig = raw;
  seededRawText = JSON.stringify(raw);
  writeFileSync(configJsonPath(), seededRawText);
  // Distinct mtime per write so the loader's file-signature cache can never
  // read two consecutive seeds as identical.
  mtimeSeq += 1;
  const stamp = new Date(Date.now() + mtimeSeq);
  utimesSync(configJsonPath(), stamp, stamp);
}

/** The raw config a route commit persisted, or null when nothing was saved. */
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

/**
 * Config responses inject the code-catalog default profiles into
 * `llm.profiles` (the effective wire view). These tests pin the MCP secret
 * boundary, so drop the injected block before whole-response comparisons.
 */
function withoutWireProfiles(
  result: Record<string, unknown>,
): Record<string, unknown> {
  const { llm: _llm, ...rest } = result;
  return rest;
}

describe("MCP config secret boundary", () => {
  beforeEach(() => {
    seedRawConfig({});
  });

  test("config_get omits legacy MCP transport headers from settings-read responses", () => {
    seedRawConfig({
      mcp: {
        servers: {
          remote: {
            transport: {
              type: "streamable-http",
              url: "https://mcp.example.com",
              headers: {
                Authorization: "Bearer mcp-secret",
                "X-API-Key": "mcp-api-secret",
              },
            },
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

  test("config_get omits headers inside malformed MCP server trees", () => {
    seedRawConfig({
      mcp: {
        servers: [
          {
            transport: {
              headers: { Authorization: "Bearer malformed-secret" },
            },
          },
        ],
      },
    });

    const result = configGetRoute.handler({}) as Record<string, unknown>;

    expect(JSON.stringify(result)).not.toContain("malformed-secret");
    expect(withoutWireProfiles(result)).toEqual({
      mcp: {
        servers: [
          {
            transport: {},
          },
        ],
      },
    });
  });

  test("config_get preserves an MCP server named headers", () => {
    seedRawConfig({
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
    });

    const result = configGetRoute.handler({}) as Record<string, unknown>;

    expect(withoutWireProfiles(result)).toEqual(rawConfig);
  });

  test("config_get preserves non-credential headers env vars", () => {
    seedRawConfig({
      mcp: {
        servers: {
          local: {
            transport: {
              type: "stdio",
              command: "npx",
              env: {
                headers: "not-a-transport-header",
              },
            },
          },
        },
      },
    });

    const result = configGetRoute.handler({}) as Record<string, unknown>;

    expect(withoutWireProfiles(result)).toEqual(rawConfig);
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

  test("config_patch allows an MCP server named headers when its value has no header credentials", async () => {
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

    expect(withoutWireProfiles(result as Record<string, unknown>)).toEqual({
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
    });
  });

  test("config_patch allows non-credential headers env vars", async () => {
    const result = await configPatchRoute.handler({
      body: {
        mcp: {
          servers: {
            local: {
              transport: {
                type: "stdio",
                command: "npx",
                env: {
                  headers: "not-a-transport-header",
                },
              },
            },
          },
        },
      },
    });

    expect(withoutWireProfiles(result as Record<string, unknown>)).toEqual({
      mcp: {
        servers: {
          local: {
            transport: {
              type: "stdio",
              command: "npx",
              env: {
                headers: "not-a-transport-header",
              },
            },
          },
        },
      },
    });
  });

  test("config_set rejects malformed MCP server trees containing headers", async () => {
    await expect(
      configSetRoute.handler({
        body: {
          path: "mcp.servers",
          value: [
            {
              transport: {
                headers: { Authorization: "Bearer malformed-secret" },
              },
            },
          ],
        },
      }),
    ).rejects.toThrow(BadRequestError);
    expect(committedRaw()).toBeNull();
  });

  test("config_set rejects direct MCP transport header paths", async () => {
    seedRawConfig({
      mcp: {
        servers: {
          remote: {
            transport: {
              type: "streamable-http",
              url: "https://mcp.example.com",
            },
          },
        },
      },
    });

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
