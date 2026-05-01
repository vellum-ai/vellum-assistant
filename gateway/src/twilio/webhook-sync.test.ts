import { afterEach, describe, expect, mock, test } from "bun:test";

import type { ConfigFileCache } from "../config-file-cache.js";
import type { CredentialCache } from "../credential-cache.js";
import { credentialKey } from "../credential-key.js";
const ACCOUNT_SID = "AC123";
const AUTH_TOKEN = "auth-token";
const PHONE_NUMBER = "+15550100";
const PHONE_NUMBER_SID = "PN123";

type FetchFn = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

interface MockedResponse {
  body?: unknown;
  status: number;
}

interface MockFetchEntry {
  init: Partial<RequestInit>;
  path: string;
  response: MockedResponse | Response;
}

const mockFetchEntries: MockFetchEntry[] = [];
const mockFetchCalls: { init: RequestInit; path: string }[] = [];
let fetchImpl: ReturnType<typeof mock<FetchFn>> = mockFetchImpl();

mock.module("../fetch.js", () => ({
  fetchImpl: (...args: Parameters<FetchFn>) => fetchImpl(...args),
}));

const { syncConfiguredTwilioPhoneNumberWebhooks } =
  await import("./webhook-sync.js");

afterEach(() => {
  resetMockFetch();
});

function makeCaches(opts: {
  phoneNumber?: string;
  accountSid?: string;
  accountSidCredential?: string;
  authToken?: string;
  ingressEnabled?: boolean;
  publicBaseUrl?: string;
  twilioPublicBaseUrl?: string;
}): { credentials: CredentialCache; configFile: ConfigFileCache } {
  const credentialValues = new Map<string, string | undefined>([
    [credentialKey("twilio", "account_sid"), opts.accountSidCredential],
    [credentialKey("twilio", "auth_token"), opts.authToken],
  ]);
  const configValues: Record<string, Record<string, string | undefined>> = {
    twilio: {
      phoneNumber: opts.phoneNumber,
      accountSid: opts.accountSid,
    },
    ingress: {
      publicBaseUrl: opts.publicBaseUrl,
      twilioPublicBaseUrl: opts.twilioPublicBaseUrl,
    },
  };

  return {
    credentials: {
      get: async (key: string) => credentialValues.get(key),
      invalidate: () => {},
    } as unknown as CredentialCache,
    configFile: {
      getString: (section: string, key: string) =>
        configValues[section]?.[key] ?? undefined,
      getBoolean: (section: string, key: string) => {
        if (section === "ingress" && key === "enabled") {
          return opts.ingressEnabled;
        }
        return undefined;
      },
      invalidate: () => {},
    } as unknown as ConfigFileCache,
  };
}

function mockFetchImpl(): ReturnType<typeof mock<FetchFn>> {
  return mock(
    async (input: string | URL | Request, actualInit?: RequestInit) => {
      const url = String(input);
      mockFetchCalls.push({ path: url, init: actualInit ?? {} });

      const idx = mockFetchEntries.findIndex((entry) => {
        if (!url.includes(entry.path)) return false;
        for (const [key, value] of Object.entries(entry.init)) {
          const actualValue = (
            actualInit as Record<string, unknown> | undefined
          )?.[key];
          if (actualValue !== value) {
            return false;
          }
        }
        return true;
      });

      if (idx === -1) {
        return new Response(JSON.stringify({ detail: "No mock matched" }), {
          status: 500,
        });
      }

      const entry = mockFetchEntries[idx];
      mockFetchEntries.splice(idx, 1);

      if (entry.response instanceof Response) {
        return entry.response;
      }

      return new Response(JSON.stringify(entry.response.body ?? null), {
        status: entry.response.status,
        headers: { "Content-Type": "application/json" },
      });
    },
  );
}

function mockFetch(
  path: string,
  init: Partial<RequestInit>,
  response: MockedResponse | Response,
): void {
  mockFetchEntries.push({ path, init, response });
}

function getMockFetchCalls(): { init: RequestInit; path: string }[] {
  return mockFetchCalls;
}

function resetMockFetch(): void {
  mockFetchEntries.length = 0;
  mockFetchCalls.length = 0;
  fetchImpl = mockFetchImpl();
}

function mockTwilioLookupAndUpdate(): void {
  mockFetch(
    `/Accounts/${ACCOUNT_SID}/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(
      PHONE_NUMBER,
    )}`,
    { method: "GET" },
    {
      status: 200,
      body: {
        incoming_phone_numbers: [
          { sid: PHONE_NUMBER_SID, phone_number: PHONE_NUMBER },
        ],
      },
    },
  );
  mockFetch(
    `/Accounts/${ACCOUNT_SID}/IncomingPhoneNumbers/${PHONE_NUMBER_SID}.json`,
    { method: "POST" },
    { status: 200, body: {} },
  );
}

describe("syncConfiguredTwilioPhoneNumberWebhooks", () => {
  test("syncs phone webhooks to twilioPublicBaseUrl when configured", async () => {
    mockTwilioLookupAndUpdate();

    await syncConfiguredTwilioPhoneNumberWebhooks(
      makeCaches({
        phoneNumber: PHONE_NUMBER,
        accountSid: ACCOUNT_SID,
        authToken: AUTH_TOKEN,
        publicBaseUrl: "https://generic.example.test",
        twilioPublicBaseUrl: " https://velay.example.test/twilio/ ",
      }),
    );

    const calls = getMockFetchCalls();
    expect(calls).toHaveLength(2);
    const body = new URLSearchParams(String(calls[1].init.body));
    expect(body.get("VoiceUrl")).toBe(
      "https://velay.example.test/twilio/webhooks/twilio/voice",
    );
    expect(body.get("VoiceMethod")).toBe("POST");
    expect(body.get("StatusCallback")).toBe(
      "https://velay.example.test/twilio/webhooks/twilio/status",
    );
    expect(body.get("StatusCallbackMethod")).toBe("POST");
    expect(calls[1].init.headers).toEqual({
      Authorization:
        "Basic " +
        Buffer.from(`${ACCOUNT_SID}:${AUTH_TOKEN}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
    });
  });

  test("falls back to generic publicBaseUrl when Twilio-specific URL is cleared", async () => {
    mockTwilioLookupAndUpdate();

    await syncConfiguredTwilioPhoneNumberWebhooks(
      makeCaches({
        phoneNumber: PHONE_NUMBER,
        accountSid: ACCOUNT_SID,
        authToken: AUTH_TOKEN,
        publicBaseUrl: "https://generic.example.test/",
        twilioPublicBaseUrl: " ",
      }),
    );

    const calls = getMockFetchCalls();
    expect(calls).toHaveLength(2);
    const body = new URLSearchParams(String(calls[1].init.body));
    expect(body.get("VoiceUrl")).toBe(
      "https://generic.example.test/webhooks/twilio/voice",
    );
    expect(body.get("StatusCallback")).toBe(
      "https://generic.example.test/webhooks/twilio/status",
    );
  });

  test("uses credential-store account SID before legacy config fallback", async () => {
    mockTwilioLookupAndUpdate();

    await syncConfiguredTwilioPhoneNumberWebhooks(
      makeCaches({
        phoneNumber: PHONE_NUMBER,
        accountSid: "AC_CONFIG_STALE",
        accountSidCredential: ACCOUNT_SID,
        authToken: AUTH_TOKEN,
        publicBaseUrl: "https://generic.example.test/",
      }),
    );

    const calls = getMockFetchCalls();
    expect(calls).toHaveLength(2);
    expect(calls[0].path).toContain(`/Accounts/${ACCOUNT_SID}/`);
    expect(calls[1].path).toContain(`/Accounts/${ACCOUNT_SID}/`);
  });

  test("skips without Twilio REST calls when required inputs are missing", async () => {
    await syncConfiguredTwilioPhoneNumberWebhooks(
      makeCaches({
        phoneNumber: PHONE_NUMBER,
        accountSid: ACCOUNT_SID,
        authToken: undefined,
        publicBaseUrl: "https://generic.example.test",
      }),
    );

    expect(getMockFetchCalls()).toEqual([]);
  });

  test("skips without Twilio REST calls when public ingress is disabled", async () => {
    await syncConfiguredTwilioPhoneNumberWebhooks(
      makeCaches({
        phoneNumber: PHONE_NUMBER,
        accountSid: ACCOUNT_SID,
        authToken: AUTH_TOKEN,
        ingressEnabled: false,
        publicBaseUrl: "https://generic.example.test",
        twilioPublicBaseUrl: "https://velay.example.test/twilio",
      }),
    );

    expect(getMockFetchCalls()).toEqual([]);
  });

  test("does not throw when Twilio lookup fails", async () => {
    mockFetch(
      `/Accounts/${ACCOUNT_SID}/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(
        PHONE_NUMBER,
      )}`,
      { method: "GET" },
      { status: 500, body: { error: "unavailable" } },
    );

    await expect(
      syncConfiguredTwilioPhoneNumberWebhooks(
        makeCaches({
          phoneNumber: PHONE_NUMBER,
          accountSid: ACCOUNT_SID,
          authToken: AUTH_TOKEN,
          publicBaseUrl: "https://generic.example.test",
        }),
      ),
    ).resolves.toBeUndefined();

    expect(getMockFetchCalls()).toHaveLength(1);
  });
});
