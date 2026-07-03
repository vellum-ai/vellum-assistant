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
let savedRawConfig: Record<string, unknown> | null = null;

function deepMerge(
  target: Record<string, unknown>,
  patch: Record<string, unknown>,
): void {
  for (const [key, value] of Object.entries(patch)) {
    if (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      target[key] !== null &&
      typeof target[key] === "object" &&
      !Array.isArray(target[key])
    ) {
      deepMerge(
        target[key] as Record<string, unknown>,
        value as Record<string, unknown>,
      );
    } else {
      target[key] = value;
    }
  }
}

function setNestedValue(
  obj: Record<string, unknown>,
  path: string,
  value: unknown,
): void {
  const keys = path.split(".");
  let current = obj;
  for (const key of keys.slice(0, -1)) {
    if (
      current[key] === null ||
      typeof current[key] !== "object" ||
      Array.isArray(current[key])
    ) {
      current[key] = {};
    }
    current = current[key] as Record<string, unknown>;
  }
  current[keys[keys.length - 1]!] = value;
}

mock.module("../config/loader.js", () => ({
  API_KEY_PROVIDERS: [],
  applyNestedDefaults: (config: unknown) => config,
  loadRawConfig: () => structuredClone(savedRawConfig ?? rawConfig),
  saveRawConfig: (raw: Record<string, unknown>) => {
    savedRawConfig = structuredClone(raw);
  },
  deepMergeOverwrite: deepMerge,
  fillContextDefaultsForMissingKeys: () => {},
  loadConfig: () => structuredClone(savedRawConfig ?? rawConfig),
  getConfig: () => structuredClone(savedRawConfig ?? rawConfig),
  getConfigReadOnly: () => structuredClone(savedRawConfig ?? rawConfig),
  getDeploymentContextDefaults: () => ({}),
  getNestedValue: (obj: Record<string, unknown>, path: string) =>
    path.split(".").reduce<unknown>((current, key) => {
      if (
        current === null ||
        typeof current !== "object" ||
        Array.isArray(current)
      ) {
        return undefined;
      }
      return (current as Record<string, unknown>)[key];
    }, obj),
  invalidateConfigCache: () => {},
  mergeDefaultWorkspaceConfig: () => ({
    merged: false,
    config: structuredClone(savedRawConfig ?? rawConfig),
  }),
  setNestedValue,
  withSuppressedConfigDiskWrites: async (fn: () => unknown) => fn(),
  withSuppressedConfigDiskWritesSync: (fn: () => unknown) => fn(),
  _writeQuarantineNotice: () => {},
}));

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
  if (!route) throw new Error(`Route not found: ${operationId}`);
  return route;
}

const configGetRoute = findRoute("config_get");
const configPatchRoute = findRoute("config_patch");
const configSetRoute = findRoute("config_set");

describe("MCP config secret boundary", () => {
  beforeEach(() => {
    rawConfig = {};
    savedRawConfig = null;
  });

  test("config_get omits legacy MCP transport headers from settings-read responses", () => {
    rawConfig = {
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
    };

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
    rawConfig = {
      mcp: {
        servers: [
          {
            transport: {
              headers: { Authorization: "Bearer malformed-secret" },
            },
          },
        ],
      },
    };

    const result = configGetRoute.handler({}) as Record<string, unknown>;

    expect(JSON.stringify(result)).not.toContain("malformed-secret");
    expect(result).toEqual({
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
    rawConfig = {
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
    };

    const result = configGetRoute.handler({}) as Record<string, unknown>;

    expect(result).toEqual(rawConfig);
  });

  test("config_get preserves non-credential headers env vars", () => {
    rawConfig = {
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
    };

    const result = configGetRoute.handler({}) as Record<string, unknown>;

    expect(result).toEqual(rawConfig);
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
    expect(savedRawConfig).toBeNull();
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

    expect(result).toEqual({
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

    expect(result).toEqual({
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
    expect(savedRawConfig).toBeNull();
  });

  test("config_set rejects direct MCP transport header paths", async () => {
    rawConfig = {
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
    };

    await expect(
      configSetRoute.handler({
        body: {
          path: "mcp.servers.remote.transport.headers.Authorization",
          value: "Bearer mcp-secret",
        },
      }),
    ).rejects.toThrow(BadRequestError);
    expect(savedRawConfig).toBeNull();
  });
});
