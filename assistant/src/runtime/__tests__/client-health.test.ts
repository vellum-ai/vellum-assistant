import { describe, expect, test } from "bun:test";

import { isClientDegraded } from "../client-health.js";

const HEARTBEAT_MS = 7_000;

describe("isClientDegraded", () => {
  test("fresh connection is not degraded (first heartbeat not due yet)", () => {
    const connectedAt = new Date(1_000_000);
    const lastActiveAt = connectedAt; // never touched yet
    const now = new Date(connectedAt.getTime() + 3_000); // 3s old
    expect(isClientDegraded(connectedAt, lastActiveAt, now, HEARTBEAT_MS)).toBe(
      false,
    );
  });

  test("mature healthy connection (lastActiveAt advancing) is not degraded", () => {
    const connectedAt = new Date(1_000_000);
    const now = new Date(connectedAt.getTime() + 60_000); // 60s old
    const lastActiveAt = new Date(now.getTime() - 2_000); // heartbeat 2s ago
    expect(isClientDegraded(connectedAt, lastActiveAt, now, HEARTBEAT_MS)).toBe(
      false,
    );
  });

  test("registered-but-not-heartbeating connection is degraded", () => {
    const connectedAt = new Date(1_000_000);
    const lastActiveAt = connectedAt; // lastActiveAt never advanced
    const now = new Date(connectedAt.getTime() + 30_000); // 30s old (> 2 * heartbeat)
    expect(isClientDegraded(connectedAt, lastActiveAt, now, HEARTBEAT_MS)).toBe(
      true,
    );
  });

  test("boundary: just under 2 heartbeat intervals old is not yet degraded", () => {
    const connectedAt = new Date(1_000_000);
    const lastActiveAt = connectedAt;
    const now = new Date(connectedAt.getTime() + 2 * HEARTBEAT_MS - 1);
    expect(isClientDegraded(connectedAt, lastActiveAt, now, HEARTBEAT_MS)).toBe(
      false,
    );
  });
});
