import { beforeEach, describe, expect, mock, test } from "bun:test";

// Silence the logger.
mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

let shareAnalytics = true;

mock.module("../platform/consent-cache.js", () => ({
  getCachedShareAnalytics: () => shareAnalytics,
}));

import { getDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import { skillLoadedEvents } from "../persistence/schema/index.js";
import {
  queryUnreportedSkillLoadedEvents,
  recordSkillLoadedEvent,
} from "./skill-loaded-events-store.js";

await initializeDb();

function insertEvent(
  id: string,
  createdAt: number,
  skillName = "web-research",
): void {
  getDb().insert(skillLoadedEvents).values({ id, createdAt, skillName }).run();
}

describe("skill-loaded-events-store", () => {
  beforeEach(() => {
    shareAnalytics = true;
    getDb().delete(skillLoadedEvents).run();
  });

  test("honors the share_analytics opt-out (records nothing)", () => {
    shareAnalytics = false;
    recordSkillLoadedEvent({ skillName: "web-research" });
    expect(queryUnreportedSkillLoadedEvents(0, undefined, 10)).toHaveLength(0);
  });

  test("record + query round-trips all fields", () => {
    recordSkillLoadedEvent({
      conversationId: "conv-xyz",
      skillName: "web-research",
      skillUpdatedAt: "2026-06-01T00:00:00.000Z",
      provider: "anthropic",
      model: "model-a",
      inferenceProfile: "balanced",
      inferenceProfileSource: "active-profile",
    });

    const rows = queryUnreportedSkillLoadedEvents(0, undefined, 10);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.id).toBeString();
    expect(row.createdAt).toBeGreaterThan(0);
    expect(row).toMatchObject({
      conversationId: "conv-xyz",
      skillName: "web-research",
      skillUpdatedAt: "2026-06-01T00:00:00.000Z",
      provider: "anthropic",
      model: "model-a",
      inferenceProfile: "balanced",
      inferenceProfileSource: "active-profile",
    });
  });

  test("optional fields persist as null", () => {
    recordSkillLoadedEvent({ skillName: "tasks" });

    const rows = queryUnreportedSkillLoadedEvents(0, undefined, 10);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      skillName: "tasks",
      conversationId: null,
      skillUpdatedAt: null,
      provider: null,
      model: null,
      inferenceProfile: null,
      inferenceProfileSource: null,
    });
  });

  test("returns rows in (createdAt, id) order", () => {
    insertEvent("sle-b", 2000);
    insertEvent("sle-a", 1000);

    const rows = queryUnreportedSkillLoadedEvents(0, undefined, 100);
    expect(rows.map((r) => r.id)).toEqual(["sle-a", "sle-b"]);
  });

  test("query advances past the compound (createdAt, id) cursor", () => {
    // Two rows in the same millisecond: pagination must use the id
    // tiebreaker to make forward progress, not loop.
    insertEvent("sle-1", 5000);
    insertEvent("sle-2", 5000);
    insertEvent("sle-3", 6000);

    const first = queryUnreportedSkillLoadedEvents(0, undefined, 1);
    expect(first.map((r) => r.id)).toEqual(["sle-1"]);

    const second = queryUnreportedSkillLoadedEvents(
      first[0]!.createdAt,
      first[0]!.id,
      100,
    );
    expect(second.map((r) => r.id)).toEqual(["sle-2", "sle-3"]);

    // Without an id cursor the timestamp-only branch is used.
    expect(
      queryUnreportedSkillLoadedEvents(5000, undefined, 100).map((r) => r.id),
    ).toEqual(["sle-3"]);

    // Cursor past the last row returns nothing.
    const last = second[second.length - 1]!;
    expect(
      queryUnreportedSkillLoadedEvents(last.createdAt, last.id, 100).length,
    ).toBe(0);
  });

  test("resumes from a persisted watermark without re-reporting", () => {
    insertEvent("sle-w1", 1000);
    insertEvent("sle-w2", 2000);

    const batch = queryUnreportedSkillLoadedEvents(0, undefined, 100);
    const watermark = batch[batch.length - 1]!;

    insertEvent("sle-w3", 3000);

    const resumed = queryUnreportedSkillLoadedEvents(
      watermark.createdAt,
      watermark.id,
      100,
    );
    expect(resumed.map((r) => r.id)).toEqual(["sle-w3"]);
  });

  test("honors the limit", () => {
    insertEvent("sle-l1", 1000);
    insertEvent("sle-l2", 2000);
    insertEvent("sle-l3", 3000);

    const rows = queryUnreportedSkillLoadedEvents(0, undefined, 2);
    expect(rows.map((r) => r.id)).toEqual(["sle-l1", "sle-l2"]);
  });
});
