import { afterEach, describe, expect, test } from "bun:test";
import { createServer } from "node:net";
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

/** Ask the OS for a free port by briefly binding to port 0. */
function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (!addr || typeof addr === "string") {
        srv.close();
        reject(new Error("Failed to get free port"));
        return;
      }
      const port = addr.port;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

/** Wait for a child process to exit, with a safety timeout. */
function waitForExit(proc: ChildProcess, timeoutMs = 5_000): Promise<void> {
  return new Promise<void>((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, timeoutMs);
    proc.on("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function startGateway(): Promise<void> {
  if (cesPort === 0)
    throw new Error(
      "CES port not assigned — call startFakeCes or reserveCesPort first",
    );
  gatewayPort = await getFreePort();

  const { GATEWAY_SECURITY_DIR: _, ...parentEnv } = process.env;
  gatewayProc = spawn("bun", ["run", gatewayEntry], {
    env: {
      ...parentEnv,
      BASE_DATA_DIR: testDir,
      GATEWAY_PORT: String(gatewayPort),
      CES_CREDENTIAL_URL: `http://127.0.0.1:${cesPort}`,
      CES_SERVICE_TOKEN: TEST_SERVICE_TOKEN,
      TELEGRAM_BOT_TOKEN: "",
      TELEGRAM_WEBHOOK_SECRET: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  // Collect stderr for diagnostics on failure.
  const stderrChunks: Buffer[] = [];
  gatewayProc.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

  // Track early exit so we can fail fast instead of polling for 30s.
  let earlyExitCode: number | null = null;
  let earlyExitSignal: string | null = null;
  gatewayProc.on("exit", (code, signal) => {
    earlyExitCode = code;
    earlyExitSignal = signal;
  });

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    // If the process already died, fail immediately with stderr.
    if (earlyExitCode !== null || earlyExitSignal !== null) {
      const stderr = Buffer.concat(stderrChunks).toString().slice(-2000);
      throw new Error(
        `Gateway exited early (code=${earlyExitCode}, signal=${earlyExitSignal})\n${stderr}`,
      );
    }
    try {
      const res = await fetch(`http://localhost:${gatewayPort}/healthz`);
      if (res.ok) return;
    } catch {
      // Gateway not ready yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const stderr = Buffer.concat(stderrChunks).toString().slice(-2000);
  throw new Error(
    `Gateway failed to start within 30 seconds\nstderr: ${stderr}`,
  );
}

function startFakeCes(opts: {
  accounts?: string[];
  credentials?: Record<string, string>;
  resolveValue?: (account: string) => string | undefined;
}): void {
  const accounts = opts.accounts ?? Object.keys(opts.credentials ?? {});
  const credentials = opts.credentials ?? {};
  cesServer = Bun.serve({
    // If cesPort was pre-reserved (for tests that start the gateway before
    // the CES), bind to that port. Otherwise let the OS pick a free one.
    port: cesPort || 0,
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
  cesPort = cesServer.port!;
}

afterEach(async () => {
  cesServer?.stop(true);
  cesServer = null;
  gatewayPort = 0;
  cesPort = 0;

  if (gatewayProc) {
    const proc = gatewayProc;
    gatewayProc = null;
    proc.kill("SIGKILL");
    // Wait for the process to actually exit so ports and file handles are
    // fully released before the next test starts.
    await waitForExit(proc);
  }

  rmSync(testDir, { recursive: true, force: true });
});

describe("gateway managed credential bootstrap retry", () => {
  test("reloads Telegram credentials after CES becomes reachable without a metadata rewrite", async () => {
    mkdirSync(testDir, { recursive: true });
    writeCredentialMetadata();

    // Reserve the CES port before starting the gateway so the gateway
    // knows where CES will eventually appear. CES isn't running yet —
    // the gateway's managed bootstrap will get ECONNREFUSED until we
    // start the fake CES below.
    cesPort = await getFreePort();
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
  }, 45_000);

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
  }, 45_000);

  test("detects new Slack credentials when metadata is written after startup with no initial channel services", async () => {
    // Start with NO channel service metadata — only non-channel credentials
    // (simulates a fresh assistant that has platform credentials but no channels).
    mkdirSync(testDir, { recursive: true });
    writeCredentialMetadata([
      metadataRecord("api-key-1", "vellum", "assistant_api_key"),
    ]);

    startFakeCes({
      credentials: {
        "credential/vellum/assistant_api_key": "fake-api-key",
        "credential/slack_channel/bot_token": "xoxb-fake-bot-token",
        "credential/slack_channel/app_token": "xapp-fake-app-token",
      },
    });

    await startGateway();

    // Slack deliver should be 503 since no Slack credentials are configured.
    const base = `http://localhost:${gatewayPort}`;
    const before = await fetch(`${base}/deliver/slack`, {
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    expect(before.status).toBe(503);

    // Now write Slack channel metadata (simulating the daemon storing
    // credentials after the user completes the Slack setup flow).
    writeCredentialMetadata([
      metadataRecord("api-key-1", "vellum", "assistant_api_key"),
      metadataRecord("bt-1", "slack_channel", "bot_token"),
      metadataRecord("at-1", "slack_channel", "app_token"),
    ]);

    // The managed bootstrap retry should still be polling (since no channel
    // services were configured at startup), so the new metadata should be
    // detected within a few seconds even without fs.watch() working.
    const deadline = Date.now() + 5_000;
    let status = before.status;
    while (Date.now() < deadline) {
      const resp = await fetch(`${base}/deliver/slack`, {
        method: "POST",
        headers: { "content-type": "application/json" },
      });
      status = resp.status;
      // 401 means Slack is configured but the deliver auth check failed
      // (which is expected since we didn't provide a valid bearer token).
      if (status === 401) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    expect(status).toBe(401);
  }, 45_000);
});
