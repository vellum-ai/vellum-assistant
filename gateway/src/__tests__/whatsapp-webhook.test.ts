import { describe, test, expect, mock, afterEach } from "bun:test";
import { createHmac } from "node:crypto";
import type { GatewayConfig } from "../config.js";
import type { CredentialCache } from "../credential-cache.js";
import { initSigningKey } from "../auth/token-service.js";

const TEST_SIGNING_KEY = Buffer.from("test-signing-key-at-least-32-bytes-long");
initSigningKey(TEST_SIGNING_KEY);

type FetchFn = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;
let fetchMock: ReturnType<typeof mock<FetchFn>> = mock(
  async () => new Response(),
);

mock.module("../fetch.js", () => ({
  fetchImpl: (...args: Parameters<FetchFn>) => fetchMock(...args),
}));

function createMockLogger(): Record<string, unknown> {
  const target = {} as Record<string, unknown>;
  const proxy = new Proxy(target, {
    get: (_innerTarget, prop) => {
      if (prop === "child") {
        return () => proxy;
      }
      if (typeof prop !== "string") return undefined;
      return (..._args: unknown[]) => {};
    },
  });
  return proxy;
}

mock.module("../logger.js", () => ({
  getLogger: () => createMockLogger(),
}));

const { createWhatsAppWebhookHandler } =
  await import("../http/routes/whatsapp-webhook.js");

const APP_SECRET = "test-whatsapp-app-secret";

afterEach(() => {
  fetchMock = mock(async () => new Response());
});

function makeConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    assistantRuntimeBaseUrl: "http://localhost:7821",
    routingEntries: [],
    defaultAssistantId: undefined,
    unmappedPolicy: "reject",
    port: 7830,
    runtimeProxyEnabled: false,
    runtimeProxyRequireAuth: true,
    shutdownDrainMs: 5000,
    runtimeTimeoutMs: 30000,
    runtimeMaxRetries: 2,
    runtimeInitialBackoffMs: 500,
    maxWebhookPayloadBytes: 1048576,
    logFile: { dir: undefined, retentionDays: 30 },
    maxAttachmentBytes: {
      telegram: 50 * 1024 * 1024,
      slack: 100 * 1024 * 1024,
      whatsapp: 16 * 1024 * 1024,
      default: 50 * 1024 * 1024,
    },
    maxAttachmentConcurrency: 3,
    gatewayInternalBaseUrl: "http://127.0.0.1:7830",
    trustProxy: false,
    ...overrides,
  };
}

/**
 * Build a WhatsApp webhook payload that normalizes to an empty messages array
 * (a status update / delivery receipt). This lets us test credential resolution
 * without needing to mock the full inbound pipeline.
 */
function makeStatusPayload(): Record<string, unknown> {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "BIZ_ACCOUNT_ID",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: {
                phone_number_id: "PHONE_ID",
                display_phone_number: "+1234567890",
              },
              statuses: [
                { id: "wamid.status1", status: "delivered", timestamp: "1234" },
              ],
            },
          },
        ],
      },
    ],
  };
}

/** Compute the X-Hub-Signature-256 header value for a given body and secret. */
function computeSignature(body: string, secret: string): string {
  const hmac = createHmac("sha256", secret).update(body, "utf8").digest("hex");
  return `sha256=${hmac}`;
}

describe("WhatsApp webhook force retry on credential-missing", () => {
  test("succeeds after force-refreshing a missing app secret", async () => {
    // First get() returns undefined; second get({ force: true }) returns the secret
    let callCount = 0;
    const credentials = {
      get: async (_key: string, opts?: { force?: boolean }) => {
        callCount++;
        if (!opts?.force) return undefined;
        return APP_SECRET;
      },
      invalidate: () => {},
    } as unknown as CredentialCache;

    const { handler } = createWhatsAppWebhookHandler(makeConfig(), {
      credentials,
    });

    const body = JSON.stringify(makeStatusPayload());
    const signature = computeSignature(body, APP_SECRET);

    const req = new Request("http://localhost:7830/webhooks/whatsapp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Hub-Signature-256": signature,
      },
      body,
    });

    const res = await handler(req);
    expect(res.status).toBe(200);
    // The credential cache should have been called at least twice (initial + force)
    expect(callCount).toBeGreaterThanOrEqual(2);
  });

  test("returns 500 when force refresh also returns undefined", async () => {
    // Both get() and get({ force: true }) return undefined
    const credentials = {
      get: async () => undefined,
      invalidate: () => {},
    } as unknown as CredentialCache;

    const { handler } = createWhatsAppWebhookHandler(makeConfig(), {
      credentials,
    });

    const body = JSON.stringify(makeStatusPayload());

    const req = new Request("http://localhost:7830/webhooks/whatsapp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Hub-Signature-256": "sha256=anything",
      },
      body,
    });

    const res = await handler(req);
    expect(res.status).toBe(500);

    const json = (await res.json()) as { error?: string };
    expect(json.error).toBe("Webhook signature validation not configured");
  });
});
