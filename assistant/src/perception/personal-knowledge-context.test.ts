import { beforeAll, beforeEach, describe, expect, test } from "bun:test";

import { getSqlite, resetDb } from "../memory/db-connection.js";
import { initializeDb } from "../memory/db-init.js";
import {
  recordPkbEpisode,
  upsertPkbEntity,
  upsertPkbPreference,
} from "../memory/personal-knowledge-store.js";
import { buildPerceptionKnowledgeContext } from "./personal-knowledge-context.js";

describe("buildPerceptionKnowledgeContext", () => {
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

  test("returns null when no PKB perception rows exist", () => {
    expect(buildPerceptionKnowledgeContext()).toBeNull();
  });

  test("renders episodes, entities, and preferences sections", () => {
    upsertPkbEntity({
      entityType: "workspace",
      canonicalName: "eli",
      confidence: 0.91,
    });
    recordPkbEpisode({
      summary: "Edited perception runtime routes and tests.",
      salience: 0.8,
    });
    upsertPkbPreference({
      key: "coding.language.preferred",
      value: "TypeScript",
      confidence: 0.92,
      learnedFrom: "perception",
    });

    const block = buildPerceptionKnowledgeContext();
    expect(block).toContain("### Recent perceived episodes");
    expect(block).toContain("### Active perceived entities");
    expect(block).toContain("### Learned preferences");
    expect(block).toContain("workspace: eli");
    expect(block).toContain("coding.language.preferred = TypeScript");
  });
});
