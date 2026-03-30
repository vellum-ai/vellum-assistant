import { afterEach, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const TEST_SERVICE_TOKEN = "test-ces-service-token";

const testDir = join(tmpdir(), `gw-managed-${Date.now()}-${Math.random()}`);

function metadataRecord(
  credentialId: string,
  service: string,
  field: string,
): Record<string, unknown> {
  return {
    credentialId,
    service,
    field,
    allowedTools: [],
    allowedDomains: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

function writeCredentialMetadata(
  credentials: Record<string, unknown>[] = [
    metadataRecord("test-bt", "telegram", "bot_token"),
    metadataRecord("test-ws", "telegram", "webhook_secret"),
  ],
): void {
  const dir = join(testDir, ".vellum", "workspace", "data", "credentials");
  mkdirSync(dir, { recursive: true });
  const metadataPath = join(dir, "metadata.json");
  const tmpPath = join(dir, `.tmp-${Date.now()}-metadata.json`);
  writeFileSync(
    tmpPath,
    JSON.stringify({
      version: 2,
      credentials,
    }),
  );
  renameSync(tmpPath, metadataPath);
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const gatewayRoot = join(__dirname, "..", "..");
const gatewayEntry = join(gatewayRoot, "src", "index.ts");

let gatewayProc: ChildProcess | null = null;
let gatewayPort = 0;
let cesPort = 0;
let cesServer: ReturnType<typeof Bun.serve> | null = null;

function assignPorts(): void {
  if (gatewayPort !== 0 && cesPort !== 0) return;
  gatewayPort = 49152 + Math.floor(Math.random() * 8_192);
  cesPort = gatewayPort + 1;
}

async function startGateway(): Promise<void> {
  assignPorts();

  gatewayProc = spawn("bun", ["run", gatewayEntry], {
    env: {
      ...process.env,
      BASE_DATA_DIR: testDir,
      GATEWAY_PORT: String(gatewayPort),
      CES_CREDENTIAL_URL: `http://127.0.0.1:${cesPort}`,
      CES_SERVICE_TOKEN: TEST_SERVICE_TOKEN,
      TELEGRAM_BOT_TOKEN: "",
      TELEGRAM_WEBHOOK_SECRET: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://localhost:${gatewayPort}/healthz`);
      if (res.ok) return;
    } catch {
      // Gateway not ready yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Gateway failed to start within 10 seconds");
}

function startFakeCes(opts: {
  accounts?: string[];
  credentials?: Record<string, string>;
  resolveValue?: (account: string) => string | undefined;
}): void {
  assignPorts();
  const accounts = opts.accounts ?? Object.keys(opts.credentials ?? {});
  const credentials = opts.credentials ?? {};
  cesServer = Bun.serve({
    port: cesPort,
    fetch(req) {
      const authHeader = req.headers.get("authorization");
      if (authHeader !== `Bearer ${TEST_SERVICE_TOKEN}`) {
        return Response.json(
          { error: "Invalid service token" },
          { status: 403 },
        );
      }

      const url = new URL(req.url);
      if (req.method === "GET" && url.pathname === "/v1/credentials") {
        return Response.json({ accounts });
      }

      if (req.method === "GET" && url.pathname.startsWith("/v1/credentials/")) {
        const account = decodeURIComponent(
          url.pathname.slice("/v1/credentials/".length),
        );
        const value = opts.resolveValue?.(account) ?? credentials[account];
        if (!value) {
          return Response.json(
            { error: "Credential not found", account },
            { status: 404 },
          );
        }
        return Response.json({ account, value });
      }

      return new Response("Not Found", { status: 404 });
    },
  });
}

afterEach(() => {
  cesServer?.stop(true);
  cesServer = null;
  gatewayPort = 0;
  cesPort = 0;

  if (gatewayProc) {
    gatewayProc.kill("SIGKILL");
    gatewayProc = null;
  }

  rmSync(testDir, { recursive: true, force: true });
});

describe("gateway managed credential bootstrap retry", () => {
  test("reloads Telegram credentials after CES becomes reachable without a metadata rewrite", async () => {
    mkdirSync(testDir, { recursive: true });
    writeCredentialMetadata();

    await startGateway();

    const base = `http://localhost:${gatewayPort}`;
    const before = await fetch(`${base}/webhooks/telegram`, { method: "POST" });
    expect(before.status).toBe(503);

    startFakeCes({
      credentials: {
        "credential/telegram/bot_token": "fake-bot-token:ABC123",
        "credential/telegram/webhook_secret": "fake-webhook-secret",
      },
    });

    const deadline = Date.now() + 5_000;
    let status = before.status;
    while (Date.now() < deadline) {
      const resp = await fetch(`${base}/webhooks/telegram`, {
        method: "POST",
      });
      status = resp.status;
      if (status === 401) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    expect(status).toBe(401);
  }, 20_000);

  test("keeps retrying until configured credential reads succeed after CES list is already available", async () => {
    mkdirSync(testDir, { recursive: true });
    writeCredentialMetadata();

    let readsReady = false;
    startFakeCes({
      accounts: [
        "credential/telegram/bot_token",
        "credential/telegram/webhook_secret",
      ],
      resolveValue(account) {
        if (!readsReady) return undefined;
        if (account === "credential/telegram/bot_token") {
          return "fake-bot-token:ABC123";
        }
        if (account === "credential/telegram/webhook_secret") {
          return "fake-webhook-secret";
        }
        return undefined;
      },
    });

    await startGateway();

    const base = `http://localhost:${gatewayPort}`;
    const before = await fetch(`${base}/webhooks/telegram`, { method: "POST" });
    expect(before.status).toBe(503);

    readsReady = true;

    const deadline = Date.now() + 5_000;
    let status = before.status;
    while (Date.now() < deadline) {
      const resp = await fetch(`${base}/webhooks/telegram`, {
        method: "POST",
      });
      status = resp.status;
      if (status === 401) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    expect(status).toBe(401);
  }, 20_000);
});
