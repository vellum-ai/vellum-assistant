/**
 * Tests for findGuardian — the guardian lookup behind
 * POST /v1/contacts/guardian/channel. The lookup now resolves from the
 * gateway DB (source of truth for ACL identity), so these seed the gateway
 * contacts table directly rather than mocking the assistant DB proxy.
 */

import {
  describe,
  test,
  expect,
  beforeAll,
  beforeEach,
  afterAll,
} from "bun:test";

import "./test-preload.js";

import {
  initGatewayDb,
  getGatewayDb,
  resetGatewayDb,
} from "../db/connection.js";
import { contacts, contactChannels } from "../db/schema.js";
import { findGuardian } from "../http/routes/guardian-channel-create.js";
import { seedContact } from "./helpers/contact-fixtures.js";

beforeAll(async () => {
  await initGatewayDb();
});

beforeEach(() => {
  const db = getGatewayDb();
  db.delete(contactChannels).run();
  db.delete(contacts).run();
});

afterAll(() => {
  resetGatewayDb();
});

describe("findGuardian", () => {
  test("returns the guardian seeded in the gateway DB", async () => {
    seedContact({ id: "g-1", role: "guardian", principalId: "prin-owner" });

    const guardian = await findGuardian();
    expect(guardian).not.toBeNull();
    expect(guardian?.id).toBe("g-1");
    expect(guardian?.principal_id).toBe("prin-owner");
  });

  test("returns null when no guardian exists", async () => {
    seedContact({ id: "c-1", role: "contact", principalId: "prin-c" });

    expect(await findGuardian()).toBeNull();
  });

  test("returns null when the guardian has no principal_id", async () => {
    seedContact({ id: "g-1", role: "guardian", principalId: null });

    expect(await findGuardian()).toBeNull();
  });
});
