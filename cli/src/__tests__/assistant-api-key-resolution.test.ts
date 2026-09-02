import { beforeEach, describe, expect, mock, test } from "bun:test";

import * as realPlatformClient from "../lib/platform-client.js";

const calls: string[] = [];
let verifyResult: "valid" | "rejected" | "unknown" | null = "valid";
let readResult: { value: string | null; unreachable: boolean } = {
  value: "stored-key",
  unreachable: false,
};

mock.module("../lib/platform-client.js", () => ({
  ...realPlatformClient,
  verifyGatewayManagedCredential: mock(async () => {
    calls.push("verify");
    return verifyResult;
  }),
  readGatewayCredential: mock(async () => {
    calls.push("read");
    return readResult;
  }),
  reprovisionAssistantApiKey: mock(async () => {
    calls.push("reprovision");
    return { provisioning: { assistant_api_key: "fresh-key" } };
  }),
}));

const { resolveAssistantApiKeyForInjection } =
  await import("../lib/assistant-api-key-resolution.js");

const ARGS = {
  registrationApiKey: null,
  runtimeUrl: "http://localhost:20101",
  bearerToken: "actor",
  token: "session",
  organizationId: "org",
  clientInstallationId: "install",
  runtimeAssistantId: "qa-loopback-auth",
  clientPlatform: "cli",
};

beforeEach(() => {
  calls.length = 0;
  verifyResult = "valid";
  readResult = { value: "stored-key", unreachable: false };
});

describe("resolveAssistantApiKeyForInjection", () => {
  test("a key the registration just issued wins without asking the gateway", async () => {
    const resolved = await resolveAssistantApiKeyForInjection({
      ...ARGS,
      registrationApiKey: "registration-key",
    });
    expect(resolved).toEqual({
      apiKey: "registration-key",
      source: "registration",
    });
    expect(calls).toEqual([]);
  });

  // The verdict comes first and the key is read after it, so the value
  // returned is the one the verdict covered, never one a concurrent repair
  // has since replaced.
  test("a stored key the platform accepts is read after the verdict", async () => {
    const resolved = await resolveAssistantApiKeyForInjection(ARGS);
    expect(resolved).toEqual({ apiKey: "stored-key", source: "stored" });
    expect(calls).toEqual(["verify", "read"]);
  });

  test("a stored key the platform rejects is replaced without being read", async () => {
    verifyResult = "rejected";
    const resolved = await resolveAssistantApiKeyForInjection(ARGS);
    expect(resolved).toEqual({ apiKey: "fresh-key", source: "reprovisioned" });
    expect(calls).toEqual(["verify", "reprovision"]);
  });

  // An unsettled answer is not a rejection: the stored key stays in use.
  test("an unsettled verdict keeps the stored key", async () => {
    verifyResult = "unknown";
    const resolved = await resolveAssistantApiKeyForInjection(ARGS);
    expect(resolved).toEqual({ apiKey: "stored-key", source: "stored" });
    expect(calls).not.toContain("reprovision");
  });

  // Rotating while the gateway is down would start the grace clock on a key
  // the assistant still needs, with nowhere to store the replacement.
  test("an unreachable gateway withholds rotation", async () => {
    verifyResult = null;
    readResult = { value: null, unreachable: true };
    const resolved = await resolveAssistantApiKeyForInjection(ARGS);
    expect(resolved).toEqual({ apiKey: null, source: "unavailable" });
    expect(calls).not.toContain("reprovision");
  });

  test("a reachable assistant with no key stored is provisioned one", async () => {
    verifyResult = "unknown";
    readResult = { value: null, unreachable: false };
    const resolved = await resolveAssistantApiKeyForInjection(ARGS);
    expect(resolved).toEqual({ apiKey: "fresh-key", source: "reprovisioned" });
    expect(calls).toEqual(["verify", "read", "reprovision"]);
  });
});
