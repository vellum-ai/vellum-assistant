import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GatewayConfig } from "../config.js";
import { initSigningKey, mintToken } from "../auth/token-service.js";
import { CURRENT_POLICY_EPOCH } from "../auth/policy.js";

const TEST_SIGNING_KEY = Buffer.from("test-signing-key-at-least-32-bytes-long");
initSigningKey(TEST_SIGNING_KEY);

function mintDaemonToken(): string {
  return mintToken({
    aud: "vellum-daemon",
    sub: "svc:gateway:self",
    scope_profile: "gateway_service_v1",
    policy_epoch: CURRENT_POLICY_EPOCH,
    ttlSeconds: 300,
  });
}

const TOKEN = mintDaemonToken();

type TwilioCredentials = {
  accountSid: string;
  authToken: string;
};

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

let rootDir = "";
let twilioCredentials: TwilioCredentials | null = null;
let storedPhoneNumber: string | null = null;
let readTwilioCredentialsImpl: () => Promise<TwilioCredentials | null> =
  async () => twilioCredentials;

const readTwilioCredentialsMock = mock(async () => readTwilioCredentialsImpl());
const readCredentialMock = mock(async (key: string) => {
  if (key === "credential:twilio:phone_number") {
    return storedPhoneNumber;
  }
  return null;
});

mock.module("../credential-reader.js", () => ({
  getRootDir: () => rootDir,
  readCredential: (key: string) => readCredentialMock(key),
  readTwilioCredentials: () => readTwilioCredentialsMock(),
}));

const { createTwilioReconcileHandler } =
  await import("../http/routes/twilio-reconcile.js");

function makeConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    assistantRuntimeBaseUrl: "http://localhost:7821",
    defaultAssistantId: undefined,
    gatewayInternalBaseUrl: "http://127.0.0.1:7830",
    logFile: { dir: undefined, retentionDays: 30 },
    maxAttachmentBytes: 20 * 1024 * 1024,
    maxAttachmentConcurrency: 3,
    maxWebhookPayloadBytes: 1024 * 1024,
    port: 7830,
    routingEntries: [],
    runtimeInitialBackoffMs: 500,
    runtimeMaxRetries: 2,
    runtimeProxyEnabled: false,
    runtimeProxyRequireAuth: true,
    runtimeTimeoutMs: 30000,
    shutdownDrainMs: 5000,
    telegramApiBaseUrl: "https://api.telegram.org",
    telegramBotToken: "bot-token",
    telegramDeliverAuthBypass: false,
    telegramInitialBackoffMs: 1000,
    telegramMaxRetries: 0,
    telegramTimeoutMs: 15000,
    telegramWebhookSecret: "webhook-secret",
    twilioAuthToken: "initial-auth-token",
    twilioAccountSid: "AC-initial",
    twilioPhoneNumber: "+15550000000",
    ingressPublicBaseUrl: "https://initial.example.com",
    unmappedPolicy: "reject",
    whatsappPhoneNumberId: undefined,
    whatsappAccessToken: undefined,
    whatsappAppSecret: undefined,
    whatsappWebhookVerifyToken: undefined,
    whatsappDeliverAuthBypass: false,
    whatsappTimeoutMs: 15000,
    whatsappMaxRetries: 3,
    whatsappInitialBackoffMs: 1000,
    slackChannelBotToken: undefined,
    slackChannelAppToken: undefined,
    slackDeliverAuthBypass: false,
    trustProxy: false,
    ...overrides,
  };
}

function makeRequest(
  method: string,
  token?: string,
  body?: Record<string, unknown>,
): Request {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }
  return new Request("http://localhost:7830/internal/twilio/reconcile", {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
}

function writeWorkspaceConfig(data: Record<string, unknown>): void {
  const workspaceDir = join(rootDir, "workspace");
  mkdirSync(workspaceDir, { recursive: true });
  writeFileSync(
    join(workspaceDir, "config.json"),
    JSON.stringify(data, null, 2),
    "utf-8",
  );
}

describe("POST /internal/twilio/reconcile", () => {
  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), "gateway-twilio-reconcile-"));
    twilioCredentials = {
      accountSid: "AC-credential",
      authToken: "credential-auth-token",
    };
    storedPhoneNumber = "+15551112222";
    readTwilioCredentialsImpl = async () => twilioCredentials;
    readTwilioCredentialsMock.mockClear();
    readCredentialMock.mockClear();
    writeWorkspaceConfig({
      twilio: {
        accountSid: "AC-config",
        phoneNumber: "+15553334444",
      },
    });
  });

  afterEach(() => {
    delete process.env.TWILIO_ACCOUNT_SID;
    delete process.env.TWILIO_AUTH_TOKEN;
    delete process.env.TWILIO_PHONE_NUMBER;
    if (rootDir) {
      rmSync(rootDir, { force: true, recursive: true });
    }
    rootDir = "";
    twilioCredentials = null;
    storedPhoneNumber = null;
    readTwilioCredentialsImpl = async () => twilioCredentials;
  });

  test("rejects non-POST methods", async () => {
    const config = makeConfig();
    const handler = createTwilioReconcileHandler(config);
    const res = await handler(
      new Request("http://localhost:7830/internal/twilio/reconcile", {
        method: "GET",
      }),
    );
    expect(res.status).toBe(405);
  });

  test("returns 401 for unauthorized requests", async () => {
    const config = makeConfig();
    const handler = createTwilioReconcileHandler(config);

    const missingAuthResponse = await handler(makeRequest("POST"));
    const invalidTokenResponse = await handler(makeRequest("POST", "wrong"));

    expect(missingAuthResponse.status).toBe(401);
    expect(invalidTokenResponse.status).toBe(401);
  });

  test("normalizes ingressPublicBaseUrl before refreshing config", async () => {
    const config = makeConfig({
      ingressPublicBaseUrl: "https://old.example.com",
    });
    const handler = createTwilioReconcileHandler(config);

    const res = await handler(
      makeRequest("POST", TOKEN, {
        ingressPublicBaseUrl: "  https://new.example.com///  ",
      }),
    );

    expect(res.status).toBe(200);
    expect(config.ingressPublicBaseUrl).toBe("https://new.example.com");
    expect(config.twilioAccountSid).toBe("AC-credential");
    expect(config.twilioAuthToken).toBe("credential-auth-token");
    expect(config.twilioPhoneNumber).toBe("+15553334444");
  });

  test("refreshes Twilio credentials after the auth token changes", async () => {
    const config = makeConfig({
      twilioAuthToken: "stale-auth-token",
      twilioAccountSid: "AC-stale",
      twilioPhoneNumber: "+15550009999",
    });
    const handler = createTwilioReconcileHandler(config);

    const firstResponse = await handler(makeRequest("POST", TOKEN));
    expect(firstResponse.status).toBe(200);
    expect(config.twilioAuthToken).toBe("credential-auth-token");
    expect(config.twilioAccountSid).toBe("AC-credential");
    expect(config.twilioPhoneNumber).toBe("+15553334444");

    twilioCredentials = {
      accountSid: "AC-credential",
      authToken: "rotated-auth-token",
    };

    const secondResponse = await handler(makeRequest("POST", TOKEN));
    expect(secondResponse.status).toBe(200);
    expect(config.twilioAuthToken).toBe("rotated-auth-token");
    expect(config.twilioAccountSid).toBe("AC-credential");
    expect(config.twilioPhoneNumber).toBe("+15553334444");
  });

  test("serializes overlapping refreshes so the latest state wins", async () => {
    const config = makeConfig({
      ingressPublicBaseUrl: "https://initial.example.com",
      twilioAuthToken: "stale-auth-token",
      twilioAccountSid: "AC-stale",
    });
    const handler = createTwilioReconcileHandler(config);

    let readCount = 0;
    const firstReadStarted = createDeferred();
    const continueFirstRead = createDeferred();

    readTwilioCredentialsImpl = async () => {
      readCount += 1;
      if (readCount === 1) {
        firstReadStarted.resolve();
        await continueFirstRead.promise;
        return {
          accountSid: "AC-first",
          authToken: "first-auth-token",
        };
      }
      return {
        accountSid: "AC-second",
        authToken: "second-auth-token",
      };
    };

    const firstReconcile = handler(
      makeRequest("POST", TOKEN, {
        ingressPublicBaseUrl: "https://first.example.com/",
      }),
    );
    await firstReadStarted.promise;

    const secondReconcile = handler(
      makeRequest("POST", TOKEN, {
        ingressPublicBaseUrl: "https://second.example.com/",
      }),
    );

    continueFirstRead.resolve();

    const [firstResponse, secondResponse] = await Promise.all([
      firstReconcile,
      secondReconcile,
    ]);

    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(200);
    expect(config.ingressPublicBaseUrl).toBe("https://second.example.com");
    expect(config.twilioAccountSid).toBe("AC-second");
    expect(config.twilioAuthToken).toBe("second-auth-token");
    expect(config.twilioPhoneNumber).toBe("+15553334444");
  });
});
