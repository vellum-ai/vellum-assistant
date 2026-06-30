import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../../../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

import { getDb } from "../../../../persistence/db-connection.js";
import { initializeDb } from "../../../../persistence/db-init.js";
import { activationSessions } from "../../../../persistence/schema/index.js";
import {
  isActivationSession,
  markActivationSession,
} from "../activation-session-store.js";

await initializeDb();

describe("activation-session-store", () => {
  beforeEach(() => {
    getDb().delete(activationSessions).run();
  });

  test("marks a conversation and reports it as an activation session", () => {
    markActivationSession("c1");
    expect(isActivationSession("c1")).toBe(true);
  });

  test("unmarked conversations are not activation sessions", () => {
    expect(isActivationSession("nope")).toBe(false);
  });

  test("marking the same conversation twice is idempotent", () => {
    markActivationSession("c1");
    markActivationSession("c1");
    expect(isActivationSession("c1")).toBe(true);
    const rows = getDb().select().from(activationSessions).all();
    expect(rows.length).toBe(1);
  });
});
