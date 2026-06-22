import { describe, expect, test } from "bun:test";

import { isClientDegraded } from "../client-health.js";

const HEARTBEAT_MS = 7_000;

describe("isClientDegraded", () => {
  test("fresh connection is not degraded", () => {
    const now = new Date(1_000_000);
    const lastActiveAt = now; // just connected
    expect(isClientDegraded(lastActiveAt, now, HEARTBEAT_MS)).toBe(false);
  });

  test("actively heartbeating connection is not degraded", () => {
    const now = new Date(1_000_000);
    const lastActiveAt = new Date(now.getTime() - 2_000); // heartbeat 2s ago
    expect(isClientDegraded(lastActiveAt, now, HEARTBEAT_MS)).toBe(false);
  });

  test("never-heartbeating connection that has gone stale is degraded", () => {
    const now = new Date(1_000_000);
    const lastActiveAt = new Date(now.getTime() - 30_000); // 30s since any activity
    expect(isClientDegraded(lastActiveAt, now, HEARTBEAT_MS)).toBe(true);
  });

  test("heartbeated then froze is degraded (stale relative to now, not connectedAt)", () => {
    const now = new Date(1_000_000);
    // Connected long ago, heartbeated for a while, then stopped an hour ago.
    const lastActiveAt = new Date(now.getTime() - 3_600_000);
    expect(isClientDegraded(lastActiveAt, now, HEARTBEAT_MS)).toBe(true);
  });

  test("boundary: just under 2 heartbeat intervals stale is not degraded", () => {
    const now = new Date(1_000_000);
    const lastActiveAt = new Date(now.getTime() - (2 * HEARTBEAT_MS - 1));
    expect(isClientDegraded(lastActiveAt, now, HEARTBEAT_MS)).toBe(false);
  });

  test("boundary: just over 2 heartbeat intervals stale is degraded", () => {
    const now = new Date(1_000_000);
    const lastActiveAt = new Date(now.getTime() - (2 * HEARTBEAT_MS + 1));
    expect(isClientDegraded(lastActiveAt, now, HEARTBEAT_MS)).toBe(true);
  });
});
