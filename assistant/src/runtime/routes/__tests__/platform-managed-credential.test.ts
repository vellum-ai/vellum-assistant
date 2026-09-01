/**
 * Unit tests for how a rejected Vellum-managed credential reaches the surfaces
 * that report platform state.
 *
 * The invariant under test is the difference between a credential being stored
 * and a credential working. Presence is not health: a rejected key is still a
 * stored key, so any surface that answers the first question while its caller
 * needs the second leaves a dead credential looking connected.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

const secureKeyValues = new Map<string, string>();

// Spread the real module: replacing it wholesale breaks unrelated importers
// pulled in by the module under test.
const actualSecureKeys = await import("../../../security/secure-keys.js");
mock.module("../../../security/secure-keys.js", () => ({
  ...actualSecureKeys,
  getSecureKeyAsync: async (account: string) => secureKeyValues.get(account),
  deleteSecureKeyAsync: async () => "deleted",
}));

const actualRegistration =
  await import("../../../inbound/platform-callback-registration.js");
mock.module("../../../inbound/platform-callback-registration.js", () => ({
  ...actualRegistration,
  resolvePlatformCallbackRegistrationContext: async () => ({
    isPlatform: false,
    platformBaseUrl: "https://platform.test",
    assistantId: "assistant-123",
    hasAssistantApiKey: true,
    authHeader: "Api-Key stored",
    enabled: true,
  }),
}));

const actualEventHub = await import("../../assistant-event-hub.js");
mock.module("../../assistant-event-hub.js", () => ({
  ...actualEventHub,
  broadcastMessage: (message: { type: string }) => {
    broadcasts.push(message.type);
  },
}));

let broadcasts: string[] = [];

const {
  clearManagedCredentialVerdict,
  getManagedCredentialVerdict,
  recordManagedCredentialVerdict,
} = await import("../../../platform/managed-credential-state.js");

const { ROUTES } = await import("../platform-routes.js");

const statusHandler = ROUTES.find(
  (r) => r.operationId === "platform_status",
)!.handler;
const connectHandler = ROUTES.find(
  (r) => r.operationId === "platform_connect",
)!.handler;

const call = (handler: (args: any) => unknown) => handler({} as any);

describe("managed credential verdict", () => {
  beforeEach(() => {
    clearManagedCredentialVerdict();
  });

  test("starts unknown, so nothing has established an answer yet", () => {
    expect(getManagedCredentialVerdict().verdict).toBe("unknown");
    expect(getManagedCredentialVerdict().observedAt).toBe(0);
  });

  test("clearing drops a recorded rejection", () => {
    recordManagedCredentialVerdict("rejected");
    expect(getManagedCredentialVerdict().verdict).toBe("rejected");

    // Storing a new key clears the verdict, which is what keeps a freshly
    // provisioned credential from inheriting the previous one's rejection.
    clearManagedCredentialVerdict();
    expect(getManagedCredentialVerdict().verdict).toBe("unknown");
  });
});

describe("platform_status", () => {
  beforeEach(() => {
    secureKeyValues.clear();
    clearManagedCredentialVerdict();
  });

  test("reports the credential verdict alongside mere presence", async () => {
    recordManagedCredentialVerdict("rejected");

    const status = (await call(statusHandler)) as {
      hasAssistantApiKey: boolean;
      assistantApiKeyStatus: string;
    };

    // Both fields are true to their own question, and they disagree on
    // purpose: a rejected key is still a stored key. Callers that need to
    // know whether managed inference works read the second.
    expect(status.hasAssistantApiKey).toBe(true);
    expect(status.assistantApiKeyStatus).toBe("rejected");
  });
});

describe("platform_connect", () => {
  beforeEach(() => {
    secureKeyValues.clear();
    secureKeyValues.set(
      "credential/vellum/platform_base_url",
      "https://p.test",
    );
    secureKeyValues.set("credential/vellum/assistant_api_key", "stored-key");
    clearManagedCredentialVerdict();
    broadcasts = [];
  });

  test("reports already connected while the stored key still works", async () => {
    const result = (await call(connectHandler)) as {
      alreadyConnected?: boolean;
    };
    expect(result.alreadyConnected).toBe(true);
    expect(broadcasts).not.toContain("show_platform_login");
  });

  test("a rejected key is not a connection, so connect asks a client to sign in", async () => {
    recordManagedCredentialVerdict("rejected");

    const result = (await call(connectHandler)) as {
      alreadyConnected?: boolean;
      showPlatformLogin?: boolean;
    };

    // Answering "already connected" here would make `platform connect` a
    // no-op against exactly the failure it exists to repair.
    expect(result.alreadyConnected).toBeUndefined();
    expect(result.showPlatformLogin).toBe(true);
    expect(broadcasts).toContain("show_platform_login");
  });
});
