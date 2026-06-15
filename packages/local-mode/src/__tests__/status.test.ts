import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

import { getLocalAssistantStatus } from "../status";

let tempDir: string;
let lockfilePath: string;
let instanceDir: string;

function writeLockfile(entry: Record<string, unknown>): void {
  writeFileSync(
    lockfilePath,
    JSON.stringify({
      assistants: [entry],
      activeAssistant: entry.assistantId,
    }),
  );
}

function writeLocalLockfile(overrides: Record<string, unknown> = {}): void {
  writeLockfile({
    assistantId: "local-1",
    cloud: "local",
    resources: {
      instanceDir,
      daemonPort: 30101,
      gatewayPort: 30102,
      qdrantPort: 30103,
    },
    ...overrides,
  });
}

function writeAssistantPid(value: string): string {
  const pidDir = path.join(instanceDir, ".vellum", "workspace");
  mkdirSync(pidDir, { recursive: true });
  const pidPath = path.join(pidDir, "vellum.pid");
  writeFileSync(pidPath, value);
  return pidPath;
}

function markStale(filePath: string): void {
  const stale = new Date(Date.now() - 120_000);
  utimesSync(filePath, stale, stale);
}

function listen(server: Server, port = 0): Promise<number> {
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("expected TCP server address");
      }
      resolve(address.port);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

async function unusedPort(): Promise<number> {
  const server = createServer();
  const port = await listen(server);
  await close(server);
  return port;
}

beforeEach(() => {
  tempDir = path.join(
    tmpdir(),
    `vellum-local-status-test-${Date.now()}-${Math.random()}`,
  );
  mkdirSync(tempDir, { recursive: true });
  lockfilePath = path.join(tempDir, "lockfile.json");
  instanceDir = path.join(tempDir, "instance");
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("getLocalAssistantStatus", () => {
  test("returns sleeping when the assistant PID file is absent", async () => {
    writeLocalLockfile();

    expect(await getLocalAssistantStatus([lockfilePath], "local-1")).toEqual({
      ok: true,
      state: "sleeping",
    });
  });

  test("returns sleeping for legacy local entries without cloud/resources", async () => {
    writeLockfile({
      assistantId: "legacy-local",
      baseDataDir: instanceDir,
      runtimeUrl: "http://127.0.0.1:30102",
    });

    expect(
      await getLocalAssistantStatus([lockfilePath], "legacy-local"),
    ).toEqual({
      ok: true,
      state: "sleeping",
    });
  });

  test("returns sleeping when the assistant PID file points at a dead process", async () => {
    writeLocalLockfile();
    writeAssistantPid("999999999");

    const result = await getLocalAssistantStatus([lockfilePath], "local-1");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.state).toBe("sleeping");
    }
  });

  test("returns crashed when the assistant PID file is invalid", async () => {
    writeLocalLockfile();
    writeAssistantPid("not-a-pid");

    const result = await getLocalAssistantStatus([lockfilePath], "local-1");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.state).toBe("crashed");
      expect(result.detail).toContain("PID file");
    }
  });

  test("returns starting when a fresh assistant PID is alive but health is not ready yet", async () => {
    writeLocalLockfile({
      resources: {
        instanceDir,
        daemonPort: await unusedPort(),
        gatewayPort: 30102,
        qdrantPort: 30103,
      },
    });
    writeAssistantPid(String(process.pid));

    const result = await getLocalAssistantStatus([lockfilePath], "local-1");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.state).toBe("starting");
      expect(result.pid).toBe(process.pid);
    }
  });

  test("returns crashed when an old live assistant PID is still not responding", async () => {
    writeLocalLockfile({
      resources: {
        instanceDir,
        daemonPort: await unusedPort(),
        gatewayPort: 30102,
        qdrantPort: 30103,
      },
    });
    const pidPath = writeAssistantPid(String(process.pid));
    markStale(pidPath);

    const result = await getLocalAssistantStatus([lockfilePath], "local-1");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.state).toBe("crashed");
      expect(result.detail).toContain("not responding");
    }
  });

  test("returns starting while the gateway is coming up for a freshly started assistant", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "healthy" }));
    });
    const daemonPort = await listen(server);
    try {
      writeLocalLockfile({
        resources: {
          instanceDir,
          daemonPort,
          gatewayPort: await unusedPort(),
          qdrantPort: 30103,
        },
      });
      writeAssistantPid(String(process.pid));

      const result = await getLocalAssistantStatus([lockfilePath], "local-1");

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.state).toBe("starting");
        expect(result.pid).toBe(process.pid);
      }
    } finally {
      await close(server);
    }
  });

  test("rejects non-local assistants", async () => {
    writeLockfile({
      assistantId: "platform-1",
      cloud: "vellum",
      runtimeUrl: "https://example.com",
    });

    expect(await getLocalAssistantStatus([lockfilePath], "platform-1")).toEqual(
      {
        ok: false,
        status: 404,
        error: "Local assistant not found",
      },
    );
  });
});
