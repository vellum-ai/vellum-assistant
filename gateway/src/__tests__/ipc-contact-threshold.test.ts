/**
 * Tests for the gateway `get_contact_threshold` IPC route.
 *
 * The handler is driven directly against a real gateway DB. Contacts are
 * seeded on the `contacts` table so the test does not depend on the
 * assistant-DB mirror that ContactStore.upsertContact performs.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import "./test-preload.js";

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
