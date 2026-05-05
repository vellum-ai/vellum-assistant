/**
 * Tests for ATL-431: guardian refresh token must enforce principal and
 * device binding. A stolen refresh token cannot be rotated using a JWT
 * that belongs to a different principal or a different device.
 */

import { describe, test, expect, beforeEach, mock } from "bun:test";

import "./test-preload.js";

// ---------------------------------------------------------------------------
// DB mock — in-memory row store for actorRefreshTokenRecords
// ---------------------------------------------------------------------------

type RefreshRecord = {
  id: string;
  tokenHash: string;
  familyId: string;
  guardianPrincipalId: string;
  hashedDeviceId: string;
  platform: string;
  status: "active" | "rotated" | "revoked";
  issuedAt: number;
  absoluteExpiresAt: number;
  inactivityExpiresAt: number;
  lastUsedAt: number | null;
  createdAt: number;
  updatedAt: number;
};

type AccessRecord = {
  id: string;
  tokenHash: string;
  guardianPrincipalId: string;
  hashedDeviceId: string;
  platform: string;
  status: "active" | "revoked";
  issuedAt: number;
  expiresAt: number;
  createdAt: number;
  updatedAt: number;
};

let refreshRows: RefreshRecord[] = [];
let accessRows: AccessRecord[] = [];
let insertedRefresh: RefreshRecord[] = [];

const mockDb = {
  select: () => mockDb,
  from: () => mockDb,
  where: (condition: unknown) => {
    void condition;
    return mockDb;
  },
  get: () => refreshRows[0] ?? null,
  update: () => mockDb,
  set: () => mockDb,
  returning: () => mockDb,
  all: () => {
    // Simulate markRotated: update the first active row
    const row = refreshRows.find((r) => r.status === "active");
    if (row) {
      row.status = "rotated";
      return [{ id: row.id }];
    }
    return [];
  },
  run: () => {},
  insert: () => mockDb,
  values: (vals: unknown) => {
    if ((vals as { tokenHash?: string }).tokenHash !== undefined) {
      // Determine if access or refresh by shape
      const v = vals as Record<string, unknown>;
      if ("absoluteExpiresAt" in v) {
        insertedRefresh.push(v as unknown as RefreshRecord);
      } else {
        accessRows.push(v as unknown as AccessRecord);
      }
    }
    return mockDb;
  },
  transaction: (fn: (tx: unknown) => unknown) => fn(null),
};

mock.module("../db/connection.js", () => ({
  getGatewayDb: () => mockDb,
}));

mock.module("../db/schema.js", () => ({
  actorRefreshTokenRecords: "actorRefreshTokenRecords",
  actorTokenRecords: "actorTokenRecords",
}));

mock.module("drizzle-orm", () => ({
  and: (...args: unknown[]) => args,
  eq: (col: unknown, val: unknown) => ({ col, val }),
}));

mock.module("../auth/guardian-bootstrap.js", () => ({
  getExternalAssistantId: () => "test-assistant",
  hashToken: (t: string) => `hash:${t}`,
  ACCESS_TOKEN_TTL_MS: 3_600_000,
  ACCESS_TOKEN_TTL_SECONDS: 3600,
  REFRESH_INACTIVITY_TTL_MS: 7_776_000_000,
  REFRESH_AFTER_FRACTION: 0.8,
}));

mock.module("../auth/token-service.js", () => ({
  mintToken: () => "minted-access-token",
}));

mock.module("../auth/policy.js", () => ({
  CURRENT_POLICY_EPOCH: 1,
}));

// Import after mocks
const { rotateCredentials } = await import("../auth/guardian-refresh.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRecord(overrides?: Partial<RefreshRecord>): RefreshRecord {
  const now = Date.now();
  return {
    id: "rec-1",
    tokenHash: "hash:valid-token",
    familyId: "family-1",
    guardianPrincipalId: "principal-A",
    hashedDeviceId: "hash:device-A",
    platform: "macos",
    status: "active",
    issuedAt: now,
    absoluteExpiresAt: now + 86_400_000 * 365,
    inactivityExpiresAt: now + 86_400_000 * 90,
    lastUsedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

beforeEach(() => {
  refreshRows = [];
  accessRows = [];
  insertedRefresh = [];
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("rotateCredentials — principal binding", () => {
  test("succeeds when principal matches the refresh token record", () => {
    refreshRows = [makeRecord()];
    const result = rotateCredentials({
      refreshToken: "valid-token",
      guardianPrincipalId: "principal-A",
      hashedDeviceId: "hash:device-A",
    });
    expect(result.ok).toBe(true);
  });

  test("rejects when JWT principal does not match the refresh token record", () => {
    refreshRows = [makeRecord()]; // record belongs to principal-A
    const result = rotateCredentials({
      refreshToken: "valid-token",
      guardianPrincipalId: "principal-B", // wrong principal
      hashedDeviceId: "hash:device-A",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("refresh_invalid");
    }
  });

  test("rejects when device does not match the refresh token record", () => {
    refreshRows = [makeRecord()]; // record belongs to device-A
    const result = rotateCredentials({
      refreshToken: "valid-token",
      guardianPrincipalId: "principal-A",
      hashedDeviceId: "hash:device-B", // wrong device
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("refresh_invalid");
    }
  });

  test("rejects when both principal and device are wrong", () => {
    refreshRows = [makeRecord()];
    const result = rotateCredentials({
      refreshToken: "valid-token",
      guardianPrincipalId: "principal-B",
      hashedDeviceId: "hash:device-B",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("refresh_invalid");
    }
  });
});

describe("rotateCredentials — existing error paths still work", () => {
  test("returns refresh_invalid for unknown token", () => {
    refreshRows = []; // no record
    const result = rotateCredentials({
      refreshToken: "unknown-token",
      guardianPrincipalId: "principal-A",
      hashedDeviceId: "hash:device-A",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("refresh_invalid");
    }
  });

  test("returns refresh_reuse_detected for an already-rotated token", () => {
    refreshRows = [makeRecord({ status: "rotated" })];
    const result = rotateCredentials({
      refreshToken: "valid-token",
      guardianPrincipalId: "principal-A",
      hashedDeviceId: "hash:device-A",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("refresh_reuse_detected");
    }
  });

  test("returns revoked for a revoked token", () => {
    refreshRows = [makeRecord({ status: "revoked" })];
    const result = rotateCredentials({
      refreshToken: "valid-token",
      guardianPrincipalId: "principal-A",
      hashedDeviceId: "hash:device-A",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("revoked");
    }
  });

  test("returns refresh_expired for an absolutely expired token", () => {
    refreshRows = [makeRecord({ absoluteExpiresAt: Date.now() - 1000 })];
    const result = rotateCredentials({
      refreshToken: "valid-token",
      guardianPrincipalId: "principal-A",
      hashedDeviceId: "hash:device-A",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("refresh_expired");
    }
  });

  test("returns refresh_expired for an inactivity-expired token", () => {
    refreshRows = [makeRecord({ inactivityExpiresAt: Date.now() - 1000 })];
    const result = rotateCredentials({
      refreshToken: "valid-token",
      guardianPrincipalId: "principal-A",
      hashedDeviceId: "hash:device-A",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("refresh_expired");
    }
  });
});
