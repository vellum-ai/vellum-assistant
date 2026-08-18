/**
 * Tests for the dev-server guardian-token route. Local assistant credentials
 * support the renderer's loopback token exchange, while paired credentials
 * stay inside the trusted host proxy.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ViteDevServer, Connect } from "vite";

import * as actualLocalMode from "@vellumai/local-mode";
import {
  guardianTokenPath,
  type DevicesListResult,
  type DevicesRevokeResult,
} from "@vellumai/local-mode";

// Per-test stubs for the CLI-spawning device helpers. The rest of the module
// stays real so the other middlewares under test keep their behavior.
let devicesListResult: DevicesListResult = { ok: true, devices: [] };
let devicesRevokeResult: DevicesRevokeResult = { ok: true };
const runDevicesListMock = mock((_invocation: unknown, _assistantId: string) =>
  Promise.resolve(devicesListResult),
);
const runDevicesRevokeMock = mock(
  (_invocation: unknown, _assistantId: string, _hashedDeviceId: string) =>
    Promise.resolve(devicesRevokeResult),
);

mock.module("@vellumai/local-mode", () => {
  const mocked: Partial<typeof import("@vellumai/local-mode")> = {
    ...actualLocalMode,
    resolveDevCliInvocation: () => ({ command: "vellum", baseArgs: [] }),
    runDevicesList: runDevicesListMock,
    runDevicesRevoke: runDevicesRevokeMock,
  };
  return mocked;
});

import { localModePlugin } from "./vite-plugin-local-mode";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "vite-local-mode-"));
const env = {
  VELLUM_ENVIRONMENT: "production",
  VELLUM_LOCKFILE_DIR: tempDir,
  XDG_CONFIG_HOME: tempDir,
};
const configDir = path.join(tempDir, "vellum");
const lockfilePath = path.join(tempDir, ".vellum.lock.json");

// Capture the plugin's middleware chain from a fake dev server so requests
// can be dispatched through it without booting Vite.
const middlewares: Connect.NextHandleFunction[] = [];
const plugin = localModePlugin(env);
const configureServer = plugin.configureServer as (server: unknown) => void;
configureServer({
  middlewares: {
    use: (handler: Connect.NextHandleFunction) => {
      middlewares.push(handler);
    },
  },
  config: { root: tempDir },
} as unknown as ViteDevServer);

afterAll(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

interface DispatchResult {
  status: number;
  body: string;
}

/** Drive a request through the captured connect chain (loopback by default). */
function dispatch(
  url: string,
  headers: Record<string, string> = {},
  options: { method?: string; body?: unknown; remoteAddress?: string } = {},
): Promise<DispatchResult> {
  const { method = "GET", body, remoteAddress = "127.0.0.1" } = options;
  return new Promise((resolve, reject) => {
    const emitter = new EventEmitter();
    const req = Object.assign(emitter, {
      url,
      method,
      headers: { host: "127.0.0.1:5173", ...headers },
      socket: { remoteAddress },
    }) as unknown as Connect.IncomingMessage;
    const res = {
      statusCode: 200,
      setHeader: () => {},
      end: (body?: unknown) => {
        resolve({ status: res.statusCode, body: String(body ?? "") });
      },
    };
    let index = 0;
    const next = (err?: unknown): void => {
      if (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      const middleware = middlewares[index++];
      if (!middleware) {
        resolve({ status: 404, body: "" });
        return;
      }
      middleware(req, res as unknown as Parameters<typeof middleware>[1], next);
    };
    next();
    if (method === "POST") {
      // Body listeners are registered synchronously by the matched middleware;
      // feed the stream on the next tick.
      setImmediate(() => {
        if (body !== undefined) {
          emitter.emit("data", Buffer.from(JSON.stringify(body)));
        }
        emitter.emit("end");
      });
    }
  });
}

const FUTURE = new Date(Date.now() + 60 * 60 * 1000).toISOString();
const PAST = new Date(Date.now() - 60_000).toISOString();

function writeToken(assistantId: string, over: Record<string, unknown>): void {
  const tokenPath = guardianTokenPath(configDir, assistantId);
  fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
  fs.writeFileSync(
    tokenPath,
    JSON.stringify({
      guardianPrincipalId: "principal",
      accessToken: "stored-token",
      accessTokenExpiresAt: FUTURE,
      refreshToken: "refresh",
      refreshTokenExpiresAt: FUTURE,
      refreshAfter: FUTURE,
      isNew: false,
      deviceId: "device",
      leasedAt: new Date().toISOString(),
      ...over,
    }),
  );
}

function writeLockfile(assistants: Array<Record<string, unknown>>): void {
  fs.writeFileSync(
    lockfilePath,
    JSON.stringify({ assistants, activeAssistant: null }),
  );
}

describe("guardian-token middleware", () => {
  beforeEach(() => {
    fs.rmSync(lockfilePath, { force: true });
    fs.rmSync(path.join(configDir, "assistants"), {
      recursive: true,
      force: true,
    });
  });

  test("returns a fresh token from the file", async () => {
    writeLockfile([{ assistantId: "asst-g", cloud: "local" }]);
    writeToken("asst-g", {});

    const result = await dispatch("/__local/guardian-token/asst-g");

    expect(result.status).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ accessToken: "stored-token" });
  });

  test("expired refresh token for a local entry yields hatch/wake guidance", async () => {
    writeLockfile([{ assistantId: "asst-g", cloud: "local" }]);
    writeToken("asst-g", {
      accessTokenExpiresAt: PAST,
      refreshTokenExpiresAt: PAST,
    });

    const result = await dispatch("/__local/guardian-token/asst-g");

    expect(result.status).toBe(401);
    const { error } = JSON.parse(result.body) as { error: string };
    expect(error).toContain("vellum hatch");
    expect(error).not.toContain("vellum pair");
  });

  test("never returns a paired credential to the renderer", async () => {
    writeLockfile([{ assistantId: "paired-g", cloud: "paired" }]);
    writeToken("paired-g", {});

    const result = await dispatch("/__local/guardian-token/paired-g");

    expect(result.status).toBe(403);
    const { error } = JSON.parse(result.body) as { error: string };
    expect(error).toContain("paired gateway proxy");
  });

  test("stored pairing metadata blocks a credential after lockfile reclassification", async () => {
    writeLockfile([{ assistantId: "paired-g", cloud: "local" }]);
    writeToken("paired-g", {
      pairedGatewayUrl: "https://gateway.example.com",
    });

    const result = await dispatch("/__local/guardian-token/paired-g");

    expect(result.status).toBe(403);
    const { error } = JSON.parse(result.body) as { error: string };
    expect(error).toContain("paired gateway proxy");
  });
});

describe("paired gateway proxy", () => {
  beforeEach(() => {
    fs.rmSync(lockfilePath, { force: true });
    fs.rmSync(path.join(configDir, "assistants"), {
      recursive: true,
      force: true,
    });
  });

  test("rejects a browser request without positive same-origin proof", async () => {
    writeLockfile([
      {
        assistantId: "paired-g",
        cloud: "paired",
        paired: true,
        runtimeUrl: "https://gateway.example.com",
      },
    ]);
    writeToken("paired-g", {
      pairedGatewayUrl: "https://gateway.example.com",
    });

    const result = await dispatch("/__gateway-paired/paired-g/readyz");

    expect(result).toEqual({ status: 403, body: "Forbidden" });
  });

  test("rejects a browser request from another loopback origin", async () => {
    writeLockfile([
      {
        assistantId: "paired-g",
        cloud: "paired",
        paired: true,
        runtimeUrl: "https://gateway.example.com",
      },
    ]);
    writeToken("paired-g", {
      pairedGatewayUrl: "https://gateway.example.com",
    });

    const result = await dispatch("/__gateway-paired/paired-g/readyz", {
      origin: "http://127.0.0.1:9999",
      "sec-fetch-site": "same-site",
    });

    expect(result).toEqual({ status: 403, body: "Forbidden" });
  });
});

describe("devices middleware", () => {
  beforeEach(() => {
    devicesListResult = { ok: true, devices: [] };
    devicesRevokeResult = { ok: true };
    runDevicesListMock.mockClear();
    runDevicesRevokeMock.mockClear();
  });

  const DEVICE = {
    hashedDeviceId: "hash-a",
    platform: "ios",
    issuedAt: 1700000000000,
    expiresAt: null,
    lastUsedAt: null,
  };

  describe("list endpoint", () => {
    test("rejects non-loopback callers", async () => {
      const result = await dispatch(
        "/__local/devices",
        {},
        {
          method: "POST",
          body: { assistantId: "asst-1" },
          remoteAddress: "192.168.1.20",
        },
      );

      expect(result.status).toBe(403);
      expect(runDevicesListMock).not.toHaveBeenCalled();
    });

    test("rejects non-POST methods", async () => {
      const result = await dispatch("/__local/devices");

      expect(result.status).toBe(405);
      expect(runDevicesListMock).not.toHaveBeenCalled();
    });

    test("400 when assistantId is missing", async () => {
      const result = await dispatch(
        "/__local/devices",
        {},
        {
          method: "POST",
          body: {},
        },
      );

      expect(result.status).toBe(400);
      expect(JSON.parse(result.body)).toEqual({
        ok: false,
        error: "Missing assistantId",
      });
    });

    test("passes the device list through on the SPA-prefixed route", async () => {
      devicesListResult = { ok: true, devices: [DEVICE] };

      const result = await dispatch(
        "/assistant/__local/devices",
        {},
        {
          method: "POST",
          body: { assistantId: "asst-1" },
        },
      );

      expect(result.status).toBe(200);
      expect(JSON.parse(result.body)).toEqual({ ok: true, devices: [DEVICE] });
      expect(runDevicesListMock).toHaveBeenCalledWith(
        { command: "vellum", baseArgs: [] },
        "asst-1",
      );
    });

    test("run-helper failure yields ok:false with no status field", async () => {
      devicesListResult = { ok: false, error: "gateway offline" };

      const result = await dispatch(
        "/__local/devices",
        {},
        {
          method: "POST",
          body: { assistantId: "asst-1" },
        },
      );

      expect(result.status).toBe(200);
      expect(JSON.parse(result.body)).toEqual({
        ok: false,
        error: "gateway offline",
      });
    });
  });

  describe("revoke endpoint", () => {
    test("rejects non-loopback callers", async () => {
      const result = await dispatch(
        "/__local/devices-revoke",
        {},
        {
          method: "POST",
          body: { assistantId: "asst-1", hashedDeviceId: "hash-a" },
          remoteAddress: "192.168.1.20",
        },
      );

      expect(result.status).toBe(403);
      expect(runDevicesRevokeMock).not.toHaveBeenCalled();
    });

    test("rejects non-POST methods", async () => {
      const result = await dispatch("/__local/devices-revoke");

      expect(result.status).toBe(405);
      expect(runDevicesRevokeMock).not.toHaveBeenCalled();
    });

    test("400 when assistantId is missing", async () => {
      const result = await dispatch(
        "/__local/devices-revoke",
        {},
        {
          method: "POST",
          body: { hashedDeviceId: "hash-a" },
        },
      );

      expect(result.status).toBe(400);
      expect(JSON.parse(result.body)).toEqual({
        ok: false,
        error: "Missing assistantId",
      });
    });

    test("400 when hashedDeviceId is missing", async () => {
      const result = await dispatch(
        "/__local/devices-revoke",
        {},
        {
          method: "POST",
          body: { assistantId: "asst-1" },
        },
      );

      expect(result.status).toBe(400);
      expect(JSON.parse(result.body)).toEqual({
        ok: false,
        error: "Missing hashedDeviceId",
      });
    });

    test("passes a successful revoke through", async () => {
      const result = await dispatch(
        "/assistant/__local/devices-revoke",
        {},
        {
          method: "POST",
          body: { assistantId: "asst-1", hashedDeviceId: "hash-a" },
        },
      );

      expect(result.status).toBe(200);
      expect(JSON.parse(result.body)).toEqual({ ok: true });
      expect(runDevicesRevokeMock).toHaveBeenCalledWith(
        { command: "vellum", baseArgs: [] },
        "asst-1",
        "hash-a",
      );
    });

    test("run-helper failure yields ok:false with no status field", async () => {
      devicesRevokeResult = { ok: false, error: "revoke failed" };

      const result = await dispatch(
        "/__local/devices-revoke",
        {},
        {
          method: "POST",
          body: { assistantId: "asst-1", hashedDeviceId: "hash-a" },
        },
      );

      expect(result.status).toBe(200);
      expect(JSON.parse(result.body)).toEqual({
        ok: false,
        error: "revoke failed",
      });
    });
  });
});
