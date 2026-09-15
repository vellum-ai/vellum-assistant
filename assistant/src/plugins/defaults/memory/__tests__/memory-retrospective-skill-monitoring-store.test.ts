import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import {
  clearStoredDb,
  setStoredDb,
} from "../../../../persistence/db-singleton.js";
import { ensureMemoryRetrospectiveSkillMonitoringSchema } from "../../../../persistence/migrations/378-create-memory-retrospective-skill-monitoring.js";
import * as schema from "../../../../persistence/schema/index.js";
import {
  getMemoryRetrospectiveSkillMonitoringForConversation,
  recordMemoryRetrospectiveSkillChange,
  recordMemoryRetrospectiveSkillDecisions,
  recordMemoryRetrospectiveSkillSearch,
} from "../memory-retrospective-skill-monitoring-store.js";

let memorySqlite: Database;

beforeEach(() => {
  memorySqlite = new Database(":memory:");
  ensureMemoryRetrospectiveSkillMonitoringSchema(memorySqlite);
  setStoredDb("memory", drizzle(memorySqlite, { schema }), () =>
    memorySqlite.close(),
  );
});

afterEach(() => {
  clearStoredDb("memory");
});

function recordSearch() {
  return recordMemoryRetrospectiveSkillSearch({
    id: "search-1",
    conversationId: "source-1",
    runConversationId: "run-1",
    goal: "deploy a preview",
    createdAt: 1000,
    candidates: [
      {
        skillId: "deploy-web",
        skillName: "Deploy Web",
        skillDescription: "Deploy the web application",
        skillSource: "managed",
        skillAuthor: "assistant",
        considerationStatus: "surfaced",
        rank: 1,
        score: 0.91,
      },
      {
        skillId: "release-notes",
        skillName: "Release Notes",
        skillDescription: "Draft release notes",
        skillSource: "bundled",
        considerationStatus: "surfaced",
        rank: 2,
        score: 0.62,
      },
      {
        skillId: "calendar-sync",
        skillName: "Calendar Sync",
        skillDescription: "Synchronize calendar events",
        skillSource: "plugin",
        considerationStatus: "excluded",
        systemExclusionReason: "below_shortlist_threshold",
        score: 0.31,
      },
    ],
  });
}

describe("retrospective skill monitoring store", () => {
  test("round-trips candidate identity, reasons, and a refinement delta", () => {
    expect(recordSearch()).toBe(true);
    expect(
      recordMemoryRetrospectiveSkillChange({
        id: "change-1",
        searchId: "search-1",
        conversationId: "source-1",
        runConversationId: "run-1",
        skillId: "deploy-web",
        operation: "refined",
        delta: "@@ -1 +1 @@\n-old\n+new\n",
        createdAt: 2000,
      }),
    ).toBe(true);
    expect(
      recordMemoryRetrospectiveSkillDecisions({
        searchId: "search-1",
        runConversationId: "run-1",
        outcome: "refined",
        reason: "The existing skill matches and needs one observed retry step.",
        decidedAt: 1500,
        decisions: [
          {
            skillId: "deploy-web",
            decision: "selected",
            reason: "Same procedure, but the observed retry step is missing.",
          },
          {
            skillId: "release-notes",
            decision: "not_selected",
            reason: "It documents a release rather than deploying one.",
          },
        ],
      }),
    ).toBe(true);

    expect(
      getMemoryRetrospectiveSkillMonitoringForConversation("source-1"),
    ).toEqual({
      searches: [
        {
          id: "search-1",
          conversationId: "source-1",
          runConversationId: "run-1",
          goal: "deploy a preview",
          outcome: "refined",
          reason:
            "The existing skill matches and needs one observed retry step.",
          decidedAt: 1500,
          createdAt: 1000,
        },
      ],
      candidates: [
        expect.objectContaining({
          skillId: "deploy-web",
          skillName: "Deploy Web",
          decision: "selected",
          reason: "Same procedure, but the observed retry step is missing.",
          decidedAt: 1500,
        }),
        expect.objectContaining({
          skillId: "release-notes",
          decision: "not_selected",
          reason: "It documents a release rather than deploying one.",
          decidedAt: 1500,
        }),
        expect.objectContaining({
          skillId: "calendar-sync",
          considerationStatus: "excluded",
          systemExclusionReason: "below_shortlist_threshold",
          decision: null,
          reason: null,
        }),
      ],
      changes: [
        expect.objectContaining({
          id: "change-1",
          skillId: "deploy-web",
          operation: "refined",
          delta: "@@ -1 +1 @@\n-old\n+new\n",
        }),
      ],
    });
  });

  test("requires exactly one decision for every returned candidate", () => {
    recordSearch();

    expect(() =>
      recordMemoryRetrospectiveSkillDecisions({
        searchId: "search-1",
        runConversationId: "run-1",
        outcome: "covered",
        reason: "Same procedure.",
        decisions: [
          {
            skillId: "deploy-web",
            decision: "selected",
            reason: "Same procedure.",
          },
        ],
      }),
    ).toThrow("exactly one entry for every returned candidate");
  });

  test("does not finalize a refinement before its scaffold delta exists", () => {
    recordSearch();

    expect(() =>
      recordMemoryRetrospectiveSkillDecisions({
        searchId: "search-1",
        runConversationId: "run-1",
        outcome: "refined",
        reason: "The existing skill needs an update.",
        decisions: [
          {
            skillId: "deploy-web",
            decision: "selected",
            reason: "Same procedure and assistant-authored.",
          },
          {
            skillId: "release-notes",
            decision: "not_selected",
            reason: "Different goal.",
          },
        ],
      }),
    ).toThrow("requires a linked successful scaffold delta");
  });

  test("rejects a created delta whose skill already existed in the evaluation", () => {
    recordSearch();

    expect(() =>
      recordMemoryRetrospectiveSkillChange({
        searchId: "search-1",
        conversationId: "source-1",
        runConversationId: "run-1",
        skillId: "deploy-web",
        operation: "created",
        delta: "new file",
      }),
    ).toThrow("already existed in the linked evaluation");
  });

  test("degrades when the memory database is unavailable", () => {
    clearStoredDb("memory");
    setStoredDb("memory", { $client: null } as never, () => {});

    expect(recordSearch()).toBe(false);
    expect(
      getMemoryRetrospectiveSkillMonitoringForConversation("source-1"),
    ).toBeNull();
  });
});
