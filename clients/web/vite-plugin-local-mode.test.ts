/**
 * Tests for the dev-server guardian-token route: the middleware classifies the
 * assistant from the lockfile and passes {paired} to getGuardianAccessToken,
 * so expired pairings get re-pair guidance instead of hatch/wake. The exact
 * guidance copy is pinned in the package's guardian-token tests; here a
 * distinguishing marker proves the route passed the paired flag.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ViteDevServer, Connect } from "vite";

import { guardianTokenPath } from "@vellumai/local-mode";

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

/** Drive a loopback GET through the captured connect chain. */
function dispatch(url: string): Promise<DispatchResult> {
  return new Promise((resolve, reject) => {
    const req = Object.assign(new EventEmitter(), {
      url,
      method: "GET",
      headers: { host: "127.0.0.1:5173" },
      socket: { remoteAddress: "127.0.0.1" },
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

  test("expired refresh token for a paired entry yields re-pair guidance", async () => {
    writeLockfile([{ assistantId: "paired-g", cloud: "paired" }]);
    writeToken("paired-g", {
      accessTokenExpiresAt: PAST,
      refreshTokenExpiresAt: PAST,
    });

    const result = await dispatch("/__local/guardian-token/paired-g");

    expect(result.status).toBe(401);
    const { error } = JSON.parse(result.body) as { error: string };
    expect(error).toContain("vellum pair");
    expect(error).not.toContain("vellum hatch");
  });
});
