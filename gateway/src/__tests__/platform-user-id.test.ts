import { beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { testSecurityDir } from "./test-preload.js";

import { credentialKey } from "../credential-key.js";

type CredResult = { value: string | undefined; unreachable: boolean };

const results = new Map<string, CredResult>();

const actualCredentialReader = await import("../credential-reader.js");
mock.module("../credential-reader.js", () => ({
  ...actualCredentialReader,
  readCredentialResult: async (account: string) =>
    results.get(account) ?? { value: undefined, unreachable: false },
}));

const {
  readPlatformIdentity,
  readStoredPlatformUserId,
  _resetLastKnownPlatformUserIdForTest,
  _dropPlatformIdentityMemoryForTest,
} = await import("../platform-user-id.js");

const { handleWhoami } = await import("../http/routes/whoami.js");

const OWNER_ID = "user-123";
const ASSISTANT_ID = "asst-123";
const ORG_ID = "org-abc";

function setLiveIdentity(identity: {
  assistantId?: string;
  userId?: string;
  organizationId?: string;
  unreachable?: boolean;
}): void {
  const unreachable = identity.unreachable ?? false;
  results.set(credentialKey("vellum", "platform_assistant_id"), {
    value: identity.assistantId,
    unreachable,
  });
  results.set(credentialKey("vellum", "platform_user_id"), {
    value: identity.userId,
    unreachable,
  });
  results.set(credentialKey("vellum", "platform_organization_id"), {
    value: identity.organizationId,
    unreachable,
  });
}

beforeEach(() => {
  _resetLastKnownPlatformUserIdForTest();
  results.clear();
});

describe("readStoredPlatformUserId", () => {
  test("returns a live owner id and caches it", async () => {
    setLiveIdentity({ userId: OWNER_ID });
    await expect(readStoredPlatformUserId()).resolves.toEqual({
      userId: OWNER_ID,
      unreachable: false,
    });
  });

  test("uses last known owner when the vault is unreachable", async () => {
    setLiveIdentity({ userId: OWNER_ID });
    await readStoredPlatformUserId();

    setLiveIdentity({ unreachable: true });
    await expect(readStoredPlatformUserId()).resolves.toEqual({
      userId: OWNER_ID,
      unreachable: false,
    });
  });

  test("reports unreachable when the vault is down and nothing is cached", async () => {
    setLiveIdentity({ unreachable: true });
    await expect(readStoredPlatformUserId()).resolves.toEqual({
      userId: undefined,
      unreachable: true,
    });
  });

  test("keeps durable identity when the vault answers empty", async () => {
    setLiveIdentity({ userId: OWNER_ID });
    await readStoredPlatformUserId();

    setLiveIdentity({});
    await expect(readStoredPlatformUserId()).resolves.toEqual({
      userId: OWNER_ID,
      unreachable: false,
    });
  });

  test("rereads the identity file after a process-local cache drop", async () => {
    setLiveIdentity({ userId: OWNER_ID });
    await readStoredPlatformUserId();
    _dropPlatformIdentityMemoryForTest();

    setLiveIdentity({ unreachable: true });
    await expect(readStoredPlatformUserId()).resolves.toEqual({
      userId: OWNER_ID,
      unreachable: false,
    });
  });

  test("does not rewrite the identity file when live ids are unchanged", async () => {
    setLiveIdentity({ userId: OWNER_ID });
    await readStoredPlatformUserId();

    const path = join(testSecurityDir, "platform-identity.json");
    const before = readFileSync(path, "utf-8");
    const mtimeBefore = statSync(path).mtimeMs;

    await readStoredPlatformUserId();
    _dropPlatformIdentityMemoryForTest();
    await readStoredPlatformUserId();

    expect(readFileSync(path, "utf-8")).toBe(before);
    expect(statSync(path).mtimeMs).toBe(mtimeBefore);
  });

  test("rewrites the identity file when live ids change", async () => {
    setLiveIdentity({ userId: OWNER_ID });
    await readStoredPlatformUserId();

    setLiveIdentity({ userId: "user-456" });
    await readStoredPlatformUserId();

    const path = join(testSecurityDir, "platform-identity.json");
    expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual({
      assistantId: null,
      userId: "user-456",
      organizationId: null,
    });
  });
});

describe("readPlatformIdentity", () => {
  test("returns all three ids from a live vault read", async () => {
    setLiveIdentity({
      assistantId: ASSISTANT_ID,
      userId: OWNER_ID,
      organizationId: ORG_ID,
    });
    await expect(readPlatformIdentity()).resolves.toEqual({
      identity: {
        assistantId: ASSISTANT_ID,
        userId: OWNER_ID,
        organizationId: ORG_ID,
      },
      unreachable: false,
    });
  });
});

describe("GET /v1/whoami", () => {
  test("returns bound identity", async () => {
    setLiveIdentity({
      assistantId: ASSISTANT_ID,
      userId: OWNER_ID,
      organizationId: ORG_ID,
    });
    const res = await handleWhoami();
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      assistantId: ASSISTANT_ID,
      userId: OWNER_ID,
      organizationId: ORG_ID,
    });
  });

  test("returns 503 when the vault is down and nothing is cached", async () => {
    setLiveIdentity({ unreachable: true });
    const res = await handleWhoami();
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("unreachable");
  });

  test("keeps serving identity when the vault answers empty", async () => {
    setLiveIdentity({
      assistantId: ASSISTANT_ID,
      userId: OWNER_ID,
      organizationId: ORG_ID,
    });
    await handleWhoami();

    setLiveIdentity({});
    const res = await handleWhoami();
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      assistantId: ASSISTANT_ID,
      userId: OWNER_ID,
      organizationId: ORG_ID,
    });
  });
});
