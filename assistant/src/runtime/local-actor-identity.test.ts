/**
 * Tests for the local-actor-identity cache-warm path.
 *
 * The SSE eager-subscribe path resolves the local actor principal
 * synchronously from the IO-free guardian-delivery cache snapshot. A cold
 * cache returns undefined, so the daemon warms it at startup
 * (`warmLocalGuardianPrincipalCache`) before clients register. These tests pin
 * that the sync read is cold before the warm and resolves the gateway-owned
 * principal after it.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { GuardianDelivery } from "@vellumai/gateway-client";

// ── Controllable IPC mock ──────────────────────────────────────────────────

type IpcHandler = (params?: Record<string, unknown>) => unknown;
const ipcHandlers = new Map<string, IpcHandler>();

mock.module("../ipc/gateway-client.js", () => ({
  ipcCall: async (method: string, params?: Record<string, unknown>) => {
    const handler = ipcHandlers.get(method);
    return handler ? handler(params) : undefined;
  },
  ipcCallPersistent: async () => undefined,
  resetPersistentClient: () => {},
}));

let httpAuthDisabled = false;
mock.module("../config/env.js", () => ({
  isHttpAuthDisabled: () => httpAuthDisabled,
}));

import { __resetGuardianDeliveryCacheForTest } from "../contacts/guardian-delivery-reader.js";
import {
  findLocalGuardianPrincipalIdFromStore,
  resolveActorPrincipalIdForLocalGuardianSync,
  warmLocalGuardianPrincipalCache,
} from "./local-actor-identity.js";

const METHOD = "resolve_guardian_delivery";

const vellumGuardian: GuardianDelivery = {
  channelType: "vellum",
  contactId: "contact-1",
  address: "self",
  status: "active",
  principalId: "principal-abc",
};

describe("warmLocalGuardianPrincipalCache", () => {
  beforeEach(() => {
    __resetGuardianDeliveryCacheForTest();
    ipcHandlers.clear();
    httpAuthDisabled = false;
  });

  afterEach(() => {
    __resetGuardianDeliveryCacheForTest();
  });

  test("sync read is cold before warming", () => {
    ipcHandlers.set(METHOD, () => ({ guardians: [vellumGuardian] }));

    // No warm yet — the cache snapshot is empty.
    expect(findLocalGuardianPrincipalIdFromStore()).toBeUndefined();
  });

  test("warming populates the cache for the sync read", async () => {
    ipcHandlers.set(METHOD, () => ({ guardians: [vellumGuardian] }));

    await warmLocalGuardianPrincipalCache();

    expect(findLocalGuardianPrincipalIdFromStore()).toBe("principal-abc");
  });

  test("cold-start SSE registration resolves the principal after warm", async () => {
    httpAuthDisabled = true;
    ipcHandlers.set(METHOD, () => ({ guardians: [vellumGuardian] }));

    // Cold cache: dev-bypass header resolves to no principal.
    expect(
      resolveActorPrincipalIdForLocalGuardianSync("dev-bypass"),
    ).toBeUndefined();

    await warmLocalGuardianPrincipalCache();

    // Warmed: the SSE sync path now resolves the gateway-owned principal.
    expect(resolveActorPrincipalIdForLocalGuardianSync("dev-bypass")).toBe(
      "principal-abc",
    );
  });

  test("warm tolerates an unreachable gateway without caching a failure", async () => {
    ipcHandlers.set(METHOD, () => {
      throw new Error("gateway down");
    });

    await warmLocalGuardianPrincipalCache();

    // Failure not cached; a later successful read warms the cache.
    expect(findLocalGuardianPrincipalIdFromStore()).toBeUndefined();
    ipcHandlers.set(METHOD, () => ({ guardians: [vellumGuardian] }));
    await warmLocalGuardianPrincipalCache();
    expect(findLocalGuardianPrincipalIdFromStore()).toBe("principal-abc");
  });
});
