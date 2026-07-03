/**
 * Tests for inbound-register's guardian lookup, which now reads from the
 * gateway DB (source of truth for ACL identity) rather than the assistant DB.
 * The gateway DB is a real (file-backed) DB seeded per test; mirrors the
 * pattern in contact-rich-read.test.ts.
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

import { findGuardian } from "../http/routes/inbound-register.js";
import {
  initGatewayDb,
  getGatewayDb,
  resetGatewayDb,
} from "../db/connection.js";
import { contacts } from "../db/schema.js";
import { seedContact } from "./helpers/contact-fixtures.js";

beforeAll(async () => {
  await initGatewayDb();
});

beforeEach(() => {
  getGatewayDb().delete(contacts).run();
});

afterAll(() => {
  resetGatewayDb();
});

describe("findGuardian", () => {
  test("finds a guardian seeded in the gateway DB", async () => {
    seedContact({ id: "g-1", role: "guardian", principalId: "principal-1" });

    const guardian = await findGuardian();
    expect(guardian).toEqual({ id: "g-1", principal_id: "principal-1" });
  });

  test("returns null when no guardian exists", async () => {
    seedContact({ id: "c-1", role: "contact", principalId: "principal-1" });

    expect(await findGuardian()).toBeNull();
  });

  test("returns null when the guardian has no principal_id", async () => {
    seedContact({ id: "g-1", role: "guardian", principalId: null });

    expect(await findGuardian()).toBeNull();
  });
});
