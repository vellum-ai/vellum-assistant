import { beforeAll, beforeEach, describe, expect, test } from "bun:test";

import { getSqlite, resetDb } from "../memory/db-connection.js";
import { initializeDb } from "../memory/db-init.js";
import {
  listPkbPreferences,
  listRecentPkbEpisodes,
} from "../memory/personal-knowledge-store.js";
import { AssistantEventHub } from "../runtime/assistant-event-hub.js";
import { perceptionEventType } from "./perception-event.js";
import { PersonalKnowledgeWriter } from "./personal-knowledge-writer.js";

describe("PersonalKnowledgeWriter", () => {
  beforeAll(() => {
    resetDb();
    initializeDb();
  });

  beforeEach(() => {
    const sqlite = getSqlite();
    sqlite.run("DELETE FROM pkb_episodes");
    sqlite.run("DELETE FROM pkb_preferences");
    sqlite.run("DELETE FROM pkb_entities");
  });

  test("persists episode + preference when relevance says remember", async () => {
    const hub = new AssistantEventHub();
    const writer = new PersonalKnowledgeWriter();
    writer.attach(hub);

    const interpretedId = "evt-code-1";
    await hub.publish({
      id: interpretedId,
      emittedAt: new Date().toISOString(),
      message: {
        type: perceptionEventType("code_edited"),
        perception: {
          eventId: interpretedId,
          ts: new Date().toISOString(),
          source: { module: "test" },
          payload: {
            kind: "code_edited",
            summary: "Edited assistant runtime routes.",
            confidence: 0.92,
            sourceEventId: "evt-focus-1",
            workspaceHint: "eli",
            languageHint: "TypeScript",
          },
        },
      },
    } as never);

    await hub.publish({
      id: "evt-rel-1",
      emittedAt: new Date().toISOString(),
      message: {
        type: perceptionEventType("relevance_scored"),
        perception: {
          eventId: "evt-rel-1",
          ts: new Date().toISOString(),
          source: { module: "test" },
          payload: {
            kind: "relevance_scored",
            sourceEventId: interpretedId,
            sourceKind: "code_edited",
            decision: "remember",
            urgency: "low",
            triggeredWake: false,
            blockedByBudget: false,
          },
        },
      },
    } as never);

    const episodes = listRecentPkbEpisodes({ limit: 10 });
    const preferences = listPkbPreferences({ limit: 10 });

    expect(episodes).toHaveLength(1);
    expect(episodes[0]?.summary).toContain("Edited assistant runtime routes");
    expect(preferences).toHaveLength(1);
    expect(preferences[0]?.key).toBe("coding.language.preferred");
    expect(preferences[0]?.value).toBe("TypeScript");

    writer.detach();
  });

  test("ignores relevance ignore decisions", async () => {
    const hub = new AssistantEventHub();
    const writer = new PersonalKnowledgeWriter();
    writer.attach(hub);

    const interpretedId = "evt-task-1";
    await hub.publish({
      id: interpretedId,
      emittedAt: new Date().toISOString(),
      message: {
        type: perceptionEventType("task_detected"),
        perception: {
          eventId: interpretedId,
          ts: new Date().toISOString(),
          source: { module: "test" },
          payload: {
            kind: "task_detected",
            label: "Refactor tests",
            summary: "Refactoring route tests",
            confidence: 0.8,
            sourceEventId: "evt-focus-2",
          },
        },
      },
    } as never);

    await hub.publish({
      id: "evt-rel-2",
      emittedAt: new Date().toISOString(),
      message: {
        type: perceptionEventType("relevance_scored"),
        perception: {
          eventId: "evt-rel-2",
          ts: new Date().toISOString(),
          source: { module: "test" },
          payload: {
            kind: "relevance_scored",
            sourceEventId: interpretedId,
            sourceKind: "task_detected",
            decision: "ignore",
            urgency: "low",
            triggeredWake: false,
            blockedByBudget: false,
          },
        },
      },
    } as never);

    expect(listRecentPkbEpisodes({ limit: 10 })).toHaveLength(0);
    writer.detach();
  });
});
