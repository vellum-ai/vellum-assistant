/**
 * Tests for the gateway contact-threshold IPC routes.
 *
 * The handlers are driven directly against a real gateway DB. Contacts are
 * seeded on the `contacts` table so the test does not depend on the
 * assistant-DB mirror that ContactStore.upsertContact performs.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";

import "./test-preload.js";

const assistantIpcCalls: Array<{
  method: string;
  params?: Record<string, unknown>;
}> = [];

mock.module("../ipc/assistant-client.js", () => ({
  ipcCallAssistant: async (
    method: string,
    params?: Record<string, unknown>,
  ) => {
    assistantIpcCalls.push({ method, params });
    return undefined;
  },
}));

import {
  getGatewayDb,
  initGatewayDb,
  resetGatewayDb,
} from "../db/connection.js";
import { contacts } from "../db/schema.js";
import { thresholdRoutes } from "../ipc/threshold-handlers.js";

beforeAll(async () => {
  await initGatewayDb();
});

beforeEach(() => {
  getGatewayDb().delete(contacts).run();
  assistantIpcCalls.length = 0;
});

afterAll(() => {
  resetGatewayDb();
});

function seedContact(opts: {
  id: string;
  autoApproveThreshold?: string | null;
}): void {
  const now = Date.now();
  getGatewayDb()
    .insert(contacts)
    .values({
      id: opts.id,
      displayName: `name-${opts.id}`,
      role: "contact",
      principalId: null,
      autoApproveThreshold: opts.autoApproveThreshold ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .run();
}

function getContactThresholdHandler() {
  const route = thresholdRoutes.find(
    (entry) => entry.method === "get_contact_threshold",
  );
  if (!route) {
    throw new Error("get_contact_threshold route is not registered");
  }
  return route.handler;
}

function setContactThresholdHandler() {
  const route = thresholdRoutes.find(
    (entry) => entry.method === "set_contact_threshold",
  );
  if (!route) {
    throw new Error("set_contact_threshold route is not registered");
  }
  return route.handler;
}

describe("get_contact_threshold IPC", () => {
  test("returns the contact ceiling when one is set", async () => {
    seedContact({ id: "contact-1", autoApproveThreshold: "high" });

    const result = await getContactThresholdHandler()({
      contactId: "contact-1",
    });

    expect(result).toEqual({ threshold: "high" });
  });

  test("returns null when the contact has no ceiling", async () => {
    seedContact({ id: "contact-1" });

    const result = await getContactThresholdHandler()({
      contactId: "contact-1",
    });

    expect(result).toBeNull();
  });

  test("returns null for an unknown contact", async () => {
    const result = await getContactThresholdHandler()({
      contactId: "contact-missing",
    });

    expect(result).toBeNull();
  });

  test("returns null for a corrupt stored ceiling", async () => {
    seedContact({ id: "contact-1", autoApproveThreshold: "full" });

    const result = await getContactThresholdHandler()({
      contactId: "contact-1",
    });

    expect(result).toBeNull();
  });
});

describe("set_contact_threshold IPC", () => {
  test("sets a contact ceiling", async () => {
    seedContact({ id: "contact-1" });

    const result = await setContactThresholdHandler()({
      contactId: "contact-1",
      threshold: "high",
    });

    expect(result).toEqual({
      ok: true,
      contactId: "contact-1",
      threshold: "high",
    });
    expect(
      await getContactThresholdHandler()({ contactId: "contact-1" }),
    ).toEqual({ threshold: "high" });
    expect(assistantIpcCalls).toEqual([
      {
        method: "emit_event",
        params: { body: { kind: "contacts_changed" } },
      },
    ]);
  });

  test("clears a contact ceiling when threshold is null", async () => {
    seedContact({ id: "contact-1", autoApproveThreshold: "high" });

    const result = await setContactThresholdHandler()({
      contactId: "contact-1",
      threshold: null,
    });

    expect(result).toEqual({
      ok: true,
      contactId: "contact-1",
      threshold: null,
    });
    expect(
      await getContactThresholdHandler()({ contactId: "contact-1" }),
    ).toBeNull();
    expect(assistantIpcCalls).toHaveLength(1);
    expect(assistantIpcCalls[0]?.method).toBe("emit_event");
  });

  test("returns not_found for an unknown contact", async () => {
    const result = await setContactThresholdHandler()({
      contactId: "contact-missing",
      threshold: "high",
    });

    expect(result).toEqual({ ok: false, error: "not_found" });
    expect(assistantIpcCalls).toEqual([]);
  });

  test("rejects an invalid threshold", async () => {
    seedContact({ id: "contact-1" });

    expect(() =>
      setContactThresholdHandler()({
        contactId: "contact-1",
        threshold: "full",
      }),
    ).toThrow();
  });
});
