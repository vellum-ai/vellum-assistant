import { beforeEach, describe, expect, mock, spyOn, test } from "bun:test";

import { setConfig } from "../../__tests__/helpers/set-config.js";

const credentials = new Map<string, string>();
const publishedCredentials: string[][] = [];
mock.module("../sync.js", () => ({
  publishMcpChanged: async () => {
    publishedCredentials.push([...credentials.keys()].sort());
  },
}));
let failedKeys = new Set<string>();
let saveHook: (() => Promise<void>) | undefined;
let deleteHook: ((key: string) => Promise<void>) | undefined;
let reloadResult = { success: true, error: undefined as string | undefined };
const reload = mock(async () => reloadResult);
mock.module("../../daemon/mcp-reload-service.js", () => ({
  reloadMcpServers: reload,
}));
const actualSecureKeys = await import("../../security/secure-keys.js");
mock.module("../../security/secure-keys.js", () => ({
  ...actualSecureKeys,
  getSecureKeyAsync: async (key: string) => credentials.get(key) ?? null,
  setSecureKeyAsync: async (key: string, value: string) => {
    await saveHook?.();
    credentials.set(key, value);
    return true;
  },
  deleteSecureKeyAsync: async (key: string) => {
    await deleteHook?.(key);
    if (failedKeys.has(key)) {
      return "error";
    }
    return credentials.delete(key) ? "deleted" : "not-found";
  },
}));
mock.module("../../plugins/mcp-servers.js", () => ({
  readPluginMcpServers: () => ({
    servers: [
      {
        id: "plugin__server",
        pluginName: "plugin",
        config: {
          transport: {
            type: "streamable-http",
            url: "https://plugin.example.com/mcp",
          },
        },
      },
    ],
    issues: [],
  }),
}));
const { loadRawConfig } = await import("../../config/loader.js");
const { ROUTES } = await import("../../runtime/routes/mcp-auth-routes.js");
const { McpOAuthProvider } = await import("../mcp-oauth-provider.js");
const { beginMcpConnection } = await import("../connection-lifecycle.js");
const {
  setMcpAuthPending,
  setMcpAuthComplete,
  setMcpAuthError,
  getMcpAuthState,
  registerMcpAuthCancellation,
} = await import("../mcp-auth-state.js");

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function handler(operation: string, body: Record<string, unknown>) {
  return ROUTES.find((entry) => entry.operationId === operation)!.handler({
    body,
  });
}
function savedServers(): Record<string, unknown> {
  return (loadRawConfig().mcp as { servers: Record<string, unknown> }).servers;
}
function provider() {
  return new McpOAuthProvider("example", "https://mcp.example.com/mcp", false, {
    requireConfigured: true,
  });
}
function seed() {
  setConfig("mcp", {
    servers: {
      example: {
        transport: {
          type: "streamable-http",
          url: "https://mcp.example.com/mcp",
        },
      },
      unrelated: { transport: { type: "stdio", command: "example-command" } },
    },
  });
  for (const key of [
    "tokens",
    "client_info",
    "client_binding",
    "discovery",
    "headers",
  ]) {
    credentials.set(`mcp:example:${key}`, "{}");
  }
}
beforeEach(() => {
  credentials.clear();
  failedKeys = new Set();
  saveHook = undefined;
  deleteHook = undefined;
  reloadResult = { success: true, error: undefined };
  reload.mockClear();
  seed();
  publishedCredentials.length = 0;
});

describe("MCP connection teardown", () => {
  test("removes every credential before removing configuration and reloading", async () => {
    expect(await handler("internal_mcp_remove", { name: "example" })).toEqual({
      removed: true,
    });
    expect(credentials.size).toBe(0);
    expect(savedServers()).not.toHaveProperty("example");
    expect(savedServers()).toHaveProperty("unrelated");
    expect(reload).toHaveBeenCalledTimes(1);
  });
  test("partial credential failures retain the server ID for a successful retry", async () => {
    failedKeys.add("mcp:example:client_binding");
    failedKeys.add("mcp:example:headers");
    await expect(
      handler("internal_mcp_remove", { name: "example" }),
    ).rejects.toThrow("retry disconnecting");
    expect(savedServers()).toHaveProperty("example");
    expect(reload).not.toHaveBeenCalled();
    expect(credentials.has("mcp:example:tokens")).toBe(false);
    failedKeys.clear();
    await handler("internal_mcp_remove", { name: "example" });
    expect(credentials.size).toBe(0);
  });
  test("cleanup waits for sibling deletions even when one deletion throws", async () => {
    const entered = deferred();
    const release = deferred();
    deleteHook = async (key) => {
      if (key.endsWith(":tokens")) {
        throw new Error("store unavailable");
      }
      if (key.endsWith(":client_binding")) {
        entered.resolve();
        await release.promise;
      }
    };
    const removal = handler("internal_mcp_remove", { name: "example" });
    await entered.promise;
    expect(savedServers()).toHaveProperty("example");
    release.resolve();
    await expect(removal).rejects.toThrow("retry disconnecting");
    expect(credentials.has("mcp:example:client_binding")).toBe(false);
    expect(savedServers()).toHaveProperty("example");
  });
  test("late refresh, registration, discovery and invalidation cannot change newer credentials", async () => {
    const old = provider();
    await handler("internal_mcp_remove", { name: "example" });
    seed();
    await beginMcpConnection("example");
    const current = provider();
    await current.saveTokens({
      access_token: "new-token",
      token_type: "Bearer",
    });
    await expect(
      old.saveTokens({ access_token: "late-token", token_type: "Bearer" }),
    ).rejects.toThrow("connection changed");
    await expect(
      old.saveClientInformation({ client_id: "late-client" }),
    ).rejects.toThrow("connection changed");
    await expect(
      old.saveDiscoveryState({
        authorizationServerUrl: "https://auth.example.com",
      }),
    ).rejects.toThrow("connection changed");
    await expect(old.invalidateCredentials("all")).rejects.toThrow(
      "connection changed",
    );
    expect(
      JSON.parse(credentials.get("mcp:example:tokens")!).access_token,
    ).toBe("new-token");
  });
  test("removal drains a credential write already in progress before deleting it", async () => {
    const entered = deferred();
    const release = deferred();
    saveHook = async () => {
      entered.resolve();
      await release.promise;
    };
    const write = provider().saveTokens({
      access_token: "refreshed-token",
      token_type: "Bearer",
    });
    await entered.promise;
    const removal = handler("internal_mcp_remove", { name: "example" });
    expect(savedServers()).toHaveProperty("example");
    release.resolve();
    await write;
    await removal;
    expect(credentials.size).toBe(0);
    expect(savedServers()).not.toHaveProperty("example");
  });
  test("runtime failure reports saved removal and retry does not delete credentials for an absent source", async () => {
    reloadResult = { success: false, error: "runtime unavailable" };
    await expect(
      handler("internal_mcp_remove", { name: "example" }),
    ).rejects.toThrow("Removal was saved");
    expect(savedServers()).not.toHaveProperty("example");
    credentials.set("mcp:example:tokens", "other-owner");
    reloadResult = { success: true, error: undefined };
    expect(await handler("internal_mcp_remove", { name: "example" })).toEqual({
      removed: true,
    });
    expect(credentials.get("mcp:example:tokens")).toBe("other-owner");
  });
  test("plugin-owned names never authorize workspace credential cleanup", async () => {
    credentials.set("mcp:plugin__server:tokens", "workspace-secret");
    await expect(
      handler("internal_mcp_remove", { name: "plugin__server" }),
    ).rejects.toThrow("not found");
    expect(credentials.get("mcp:plugin__server:tokens")).toBe(
      "workspace-secret",
    );
  });
  test("legacy revoke keeps configuration and static headers", async () => {
    expect(
      await handler("internal_mcp_auth_revoke", { serverId: "example" }),
    ).toEqual({ revoked: true });
    expect(savedServers()).toHaveProperty("example");
    expect([...credentials.keys()]).toEqual(["mcp:example:headers"]);
  });
  test("attempt-scoped cancellation rejects old IDs and fences the current attempt", async () => {
    const pending = provider();
    setMcpAuthPending("example", "https://auth.example.com", "current-attempt");
    registerMcpAuthCancellation("example", "current-attempt", () =>
      pending.close(),
    );
    expect(
      await handler("internal_mcp_auth_cancel", {
        serverId: "example",
        attemptId: "older-attempt",
      }),
    ).toEqual({ cancelled: false });
    expect(getMcpAuthState("example")?.status).toBe("pending");
    expect(
      await handler("internal_mcp_auth_cancel", {
        serverId: "example",
        attemptId: "current-attempt",
      }),
    ).toEqual({ cancelled: true });
    await expect(
      pending.saveTokens({ access_token: "late-token", token_type: "Bearer" }),
    ).rejects.toThrow("connection changed");
    expect(setMcpAuthComplete("example", "current-attempt")).toBe(false);
    expect(setMcpAuthError("example", "late error", "current-attempt")).toBe(
      false,
    );
    expect(savedServers()).toHaveProperty("example");
    expect([...credentials.keys()]).toEqual(["mcp:example:headers"]);
  });
  test.each([false, true])(
    "cancellation publishes settled credential cleanup, including partial failure: %s",
    async (partialFailure) => {
      const entered = deferred();
      const release = deferred();
      deleteHook = async (key) => {
        if (key.endsWith(":tokens")) {
          entered.resolve();
          await release.promise;
        }
      };
      if (partialFailure) {
        failedKeys.add("mcp:example:client_binding");
      }
      setMcpAuthPending(
        "example",
        "https://auth.example.com",
        "cancel-attempt",
      );
      publishedCredentials.length = 0;
      const cancellation = handler("internal_mcp_auth_cancel", {
        serverId: "example",
        attemptId: "cancel-attempt",
      });
      await entered.promise;
      expect(publishedCredentials.at(-1)).toContain("mcp:example:tokens");
      release.resolve();
      if (partialFailure) {
        await expect(cancellation).rejects.toThrow("credential cleanup failed");
      } else {
        expect(await cancellation).toEqual({ cancelled: true });
      }
      expect(publishedCredentials.at(-1)).toEqual(
        partialFailure
          ? ["mcp:example:client_binding", "mcp:example:headers"]
          : ["mcp:example:headers"],
      );
    },
  );
  test("failed cancellation retries the same attempt after the status grace period", async () => {
    setMcpAuthPending("example", "https://auth.example.com", "retry-attempt");
    const close = mock(() => {});
    registerMcpAuthCancellation("example", "retry-attempt", close);
    failedKeys.add("mcp:example:client_binding");
    const request = { serverId: "example", attemptId: "retry-attempt" };
    await expect(handler("internal_mcp_auth_cancel", request)).rejects.toThrow(
      "retry cancelling",
    );

    const clock = spyOn(Date, "now").mockReturnValue(Date.now() + 120_000);
    try {
      expect(getMcpAuthState("example")).toMatchObject({
        status: "error",
        attemptId: "retry-attempt",
        cancellationCleanupPending: true,
      });
      const entered = deferred();
      const release = deferred();
      failedKeys.clear();
      deleteHook = async (key) => {
        if (key.endsWith(":client_binding")) {
          entered.resolve();
          await release.promise;
        }
      };
      publishedCredentials.length = 0;
      const retry = handler("internal_mcp_auth_cancel", request);
      await entered.promise;
      expect(credentials.has("mcp:example:client_binding")).toBe(true);
      expect(publishedCredentials).toHaveLength(0);
      release.resolve();

      expect(await retry).toEqual({ cancelled: true });
      expect(close).toHaveBeenCalledTimes(1);
      expect(publishedCredentials.at(-1)).toEqual(["mcp:example:headers"]);
      expect(savedServers()).toHaveProperty("example");
      expect(getMcpAuthState("example")).toMatchObject({
        cancellationCleanupPending: false,
      });
      expect(await handler("internal_mcp_auth_cancel", request)).toEqual({
        cancelled: false,
      });
    } finally {
      clock.mockRestore();
    }
  });
  test("authorization start settles failed cancellation before replacing its state", async () => {
    setMcpAuthPending("example", "https://auth.example.com", "cleanup-attempt");
    failedKeys.add("mcp:example:tokens");
    await expect(
      handler("internal_mcp_auth_cancel", {
        serverId: "example",
        attemptId: "cleanup-attempt",
      }),
    ).rejects.toThrow("credential cleanup failed");

    const startCallback = spyOn(
      McpOAuthProvider.prototype,
      "startCallbackServer",
    ).mockRejectedValue(new Error("new authorization started"));
    try {
      await expect(
        handler("internal_mcp_auth_start", { serverId: "example" }),
      ).rejects.toThrow("credential cleanup failed");
      expect(startCallback).not.toHaveBeenCalled();
      expect(getMcpAuthState("example")).toMatchObject({
        status: "error",
        attemptId: "cleanup-attempt",
        cancellationCleanupPending: true,
      });
      expect(credentials.has("mcp:example:tokens")).toBe(true);

      failedKeys.clear();
      await expect(
        handler("internal_mcp_auth_start", { serverId: "example" }),
      ).rejects.toThrow("new authorization started");
      expect(startCallback).toHaveBeenCalledTimes(1);
      expect([...credentials.keys()]).toEqual(["mcp:example:headers"]);
      expect(getMcpAuthState("example")?.attemptId).not.toBe("cleanup-attempt");
      expect(savedServers()).toHaveProperty("example");
    } finally {
      startCallback.mockRestore();
    }
  });
  test("a stale cleanup retry cannot cancel or clear a newer attempt", async () => {
    setMcpAuthPending("example", "https://auth.example.com", "failed-attempt");
    failedKeys.add("mcp:example:tokens");
    const request = { serverId: "example", attemptId: "failed-attempt" };
    await expect(handler("internal_mcp_auth_cancel", request)).rejects.toThrow(
      "credential cleanup failed",
    );
    failedKeys.clear();
    setMcpAuthPending("example", "https://auth.example.com", "new-attempt");
    const closeNew = mock(() => {});
    registerMcpAuthCancellation("example", "new-attempt", closeNew);
    credentials.set("mcp:example:tokens", "new-attempt-token");
    publishedCredentials.length = 0;

    expect(await handler("internal_mcp_auth_cancel", request)).toEqual({
      cancelled: false,
    });
    expect(closeNew).not.toHaveBeenCalled();
    expect(credentials.get("mcp:example:tokens")).toBe("new-attempt-token");
    expect(getMcpAuthState("example")).toMatchObject({
      status: "pending",
      attemptId: "new-attempt",
    });
    expect(publishedCredentials).toHaveLength(0);
  });
  test("an ordinary OAuth error does not authorize cancellation cleanup", async () => {
    setMcpAuthPending("example", "https://auth.example.com", "error-attempt");
    setMcpAuthError("example", "Connection cancelled", "error-attempt");
    const before = [...credentials.entries()];
    expect(
      await handler("internal_mcp_auth_cancel", {
        serverId: "example",
        attemptId: "error-attempt",
      }),
    ).toEqual({ cancelled: false });
    expect([...credentials.entries()]).toEqual(before);
  });
  test.each(["internal_mcp_remove", "internal_mcp_auth_revoke"])(
    "%s also settles a failed cancellation's cleanup state",
    async (operation) => {
      setMcpAuthPending(
        "example",
        "https://auth.example.com",
        "cleanup-attempt",
      );
      failedKeys.add("mcp:example:tokens");
      await expect(
        handler("internal_mcp_auth_cancel", {
          serverId: "example",
          attemptId: "cleanup-attempt",
        }),
      ).rejects.toThrow("credential cleanup failed");
      failedKeys.clear();

      await handler(
        operation,
        operation === "internal_mcp_remove"
          ? { name: "example" }
          : { serverId: "example" },
      );

      expect(getMcpAuthState("example")).toMatchObject({
        cancellationCleanupPending: false,
      });
    },
  );
  test("concurrent add and remove preserve unrelated configuration writes", async () => {
    const entered = deferred();
    const release = deferred();
    saveHook = async () => {
      entered.resolve();
      await release.promise;
    };
    const addition = handler("internal_mcp_add", {
      name: "added",
      transportType: "streamable-http",
      url: "https://added.example.com/mcp",
      headers: { Authorization: "Bearer example-token" },
    });
    await entered.promise;
    const removal = handler("internal_mcp_remove", { name: "example" });
    release.resolve();
    await addition;
    await removal;
    expect(Object.keys(savedServers()).sort()).toEqual(["added", "unrelated"]);
    expect(credentials.has("mcp:added:headers")).toBe(true);
  });
  test("missing auth state cannot be recreated by a stale completion", () => {
    expect(setMcpAuthComplete("missing-server", "old-attempt")).toBe(false);
    expect(setMcpAuthError("missing-server", "late error", "old-attempt")).toBe(
      false,
    );
    expect(getMcpAuthState("missing-server")).toBeNull();
  });
});
