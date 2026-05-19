import { beforeAll, beforeEach, describe, expect, test } from "bun:test";

import { getSqlite, resetDb } from "../../memory/db-connection.js";
import { initializeDb } from "../../memory/db-init.js";
import {
  recordPkbEpisode,
  upsertPkbEntity,
  upsertPkbPreference,
} from "../../memory/personal-knowledge-store.js";
import { ROUTES } from "./personal-knowledge-routes.js";

const entitiesRoute = ROUTES.find(
  (route) => route.operationId === "personal_knowledge_entities",
);
const episodesRoute = ROUTES.find(
  (route) => route.operationId === "personal_knowledge_episodes",
);
const preferencesRoute = ROUTES.find(
  (route) => route.operationId === "personal_knowledge_preferences",
);

if (!entitiesRoute || !episodesRoute || !preferencesRoute) {
  throw new Error("personal knowledge routes are not registered");
}

describe("personal knowledge routes", () => {
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

  test("entities route searches canonical names and aliases", () => {
    upsertPkbEntity({
      entityType: "project",
      canonicalName: "jarvis roadmap",
      aliases: ["roadmap"],
    });

    const result = entitiesRoute.handler({ queryParams: { query: "roadmap" } });
    expect((result as { entries: unknown[] }).entries).toHaveLength(1);
  });

  test("episodes route returns recent episodes", () => {
    recordPkbEpisode({ summary: "older", happenedAt: 1000 });
    recordPkbEpisode({ summary: "newer", happenedAt: 2000 });

    const result = episodesRoute.handler({ queryParams: { limit: "1" } }) as {
      entries: Array<{ summary: string }>;
    };
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.summary).toBe("newer");
  });

  test("preferences route returns learned preferences", () => {
    upsertPkbPreference({
      key: "coding.language.preferred",
      value: "TypeScript",
      confidence: 0.9,
      learnedFrom: "perception",
    });

    const result = preferencesRoute.handler({
      queryParams: { limit: "10" },
    }) as { entries: Array<{ key: string; value: string }> };
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({
      key: "coding.language.preferred",
      value: "TypeScript",
    });
  });
});
