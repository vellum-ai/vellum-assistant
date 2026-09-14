import { beforeEach, describe, expect, mock, test } from "bun:test";

import "./test-preload.js";

let mockResult: { value: string | undefined; unreachable: boolean } = {
  value: undefined,
  unreachable: false,
};

const actualCredentialReader = await import("../credential-reader.js");
mock.module("../credential-reader.js", () => ({
  ...actualCredentialReader,
  readCredentialResult: async () => mockResult,
}));

const { readStoredPlatformUserId, _resetLastKnownPlatformUserIdForTest } =
  await import("../platform-user-id.js");

const OWNER_ID = "user-123";

beforeEach(() => {
  _resetLastKnownPlatformUserIdForTest();
  mockResult = { value: undefined, unreachable: false };
});

describe("readStoredPlatformUserId", () => {
  test("returns a live owner id and caches it", async () => {
    mockResult = { value: OWNER_ID, unreachable: false };
    await expect(readStoredPlatformUserId()).resolves.toEqual({
      userId: OWNER_ID,
      unreachable: false,
    });
  });

  test("uses last known owner when the vault is unreachable", async () => {
    mockResult = { value: OWNER_ID, unreachable: false };
    await readStoredPlatformUserId();

    mockResult = { value: undefined, unreachable: true };
    await expect(readStoredPlatformUserId()).resolves.toEqual({
      userId: OWNER_ID,
      unreachable: false,
    });
  });

  test("reports unreachable when the vault is down and nothing is cached", async () => {
    mockResult = { value: undefined, unreachable: true };
    await expect(readStoredPlatformUserId()).resolves.toEqual({
      userId: undefined,
      unreachable: true,
    });
  });

  test("a genuine miss clears the last known owner", async () => {
    mockResult = { value: OWNER_ID, unreachable: false };
    await readStoredPlatformUserId();

    mockResult = { value: undefined, unreachable: false };
    await expect(readStoredPlatformUserId()).resolves.toEqual({
      userId: undefined,
      unreachable: false,
    });

    mockResult = { value: undefined, unreachable: true };
    await expect(readStoredPlatformUserId()).resolves.toEqual({
      userId: undefined,
      unreachable: true,
    });
  });
});
