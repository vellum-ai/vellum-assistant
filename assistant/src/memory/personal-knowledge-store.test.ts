import { beforeAll, beforeEach, describe, expect, test } from "bun:test";

import { getSqlite, resetDb } from "./db-connection.js";
import { initializeDb } from "./db-init.js";
import {
  findPkbEntities,
  listPkbPreferences,
  listRecentPkbEntities,
  listRecentPkbEpisodes,
  recordPkbEpisode,
  scorePkbEntities,
  upsertPkbEntity,
  upsertPkbPreference,
} from "./personal-knowledge-store.js";

describe("personal-knowledge-store", () => {
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

  test("upsertPkbEntity merges aliases/attributes and counter-weights confidence", () => {
    const first = upsertPkbEntity({
      entityType: "person",
      canonicalName: "Alice",
      aliases: ["Al"],
      attributes: { team: "platform" },
      confidence: 0.4,
    });
    const second = upsertPkbEntity({
      entityType: "person",
      canonicalName: "alice",
      aliases: ["A."],
      attributes: { role: "engineer" },
      confidence: 0.9,
    });

    expect(first.id).toBe(second.id);
    // Counter-weighted mean: (1 * 0.4 + 0.9) / 2 = 0.65
    expect(second.confidence).toBeCloseTo(0.65, 5);
    expect(second.evidenceCount).toBe(2);
    expect(second.aliasesJson).toContain("Al");
    expect(second.aliasesJson).toContain("A.");
    expect(second.attributesJson).toContain("platform");
    expect(second.attributesJson).toContain("engineer");
  });

  test("findPkbEntities searches canonical names and aliases", () => {
    upsertPkbEntity({
      entityType: "project",
      canonicalName: "jarvis hud",
      aliases: ["hud"],
    });
    upsertPkbEntity({
      entityType: "project",
      canonicalName: "meeting bot",
      aliases: ["bots"],
    });

    const byName = findPkbEntities({ query: "jarvis", limit: 10 });
    const byAlias = findPkbEntities({ query: "hud", limit: 10 });

    expect(byName).toHaveLength(1);
    expect(byAlias).toHaveLength(1);
    expect(byAlias[0]?.canonicalName).toBe("jarvis hud");
  });

  test("listRecentPkbEntities returns newest entities first", () => {
    upsertPkbEntity({
      entityType: "project",
      canonicalName: "older",
      confidence: 0.5,
    });
    upsertPkbEntity({
      entityType: "project",
      canonicalName: "newer",
      confidence: 0.7,
    });

    const recent = listRecentPkbEntities({ limit: 2 });
    expect(recent).toHaveLength(2);
    expect(recent[0]?.canonicalName).toBe("newer");
    expect(recent[1]?.canonicalName).toBe("older");
  });

  test("recordPkbEpisode stores episode and lists newest first", () => {
    const older = recordPkbEpisode({
      summary: "older episode",
      happenedAt: 1000,
      salience: 0.2,
    });
    const newer = recordPkbEpisode({
      summary: "newer episode",
      happenedAt: 2000,
      salience: 0.9,
    });

    const episodes = listRecentPkbEpisodes({ limit: 10 });
    expect(episodes.map((e) => e.id)).toEqual([newer.id, older.id]);
  });

  test("upsertPkbPreference reinforces with positive signal (default)", () => {
    const first = upsertPkbPreference({
      key: "coding.style",
      value: "concise",
      confidence: 0.4,
    });
    const second = upsertPkbPreference({
      key: "coding.style",
      value: "concise",
      learnedFrom: "conversation",
    });

    expect(first.id).toBe(second.id);
    // Two positive observations → beta-mean = 2/(2+0) = 1.0
    expect(second.confidence).toBe(1);
    expect(second.positiveCount).toBe(2);
    expect(second.negativeCount).toBe(0);
    expect(second.evidenceCount).toBe(2);

    const prefs = listPkbPreferences({ limit: 10 });
    expect(prefs).toHaveLength(1);
  });

  test("upsertPkbPreference contradicted signal overwrites value and bumps negative counter", () => {
    upsertPkbPreference({
      key: "coding.style",
      value: "concise",
      confidence: 0.4,
    });
    const contradicted = upsertPkbPreference({
      key: "coding.style",
      value: "detailed",
      signal: "negative",
    });
    // 1 positive, 1 negative → 1/(1+1) = 0.5
    expect(contradicted.confidence).toBeCloseTo(0.5, 5);
    expect(contradicted.value).toBe("detailed");
    expect(contradicted.negativeCount).toBe(1);
    expect(contradicted.lastContradictedAt).not.toBeNull();
  });

  test("recordPkbEpisode is idempotent on idempotencyKey", () => {
    const a = recordPkbEpisode({
      summary: "first",
      idempotencyKey: "src-1:task_detected",
    });
    const b = recordPkbEpisode({
      summary: "second (should be ignored)",
      idempotencyKey: "src-1:task_detected",
    });
    expect(a.id).toBe(b.id);
    expect(b.summary).toBe("first");
    expect(listRecentPkbEpisodes({ limit: 10 })).toHaveLength(1);
  });

  test("scorePkbEntities ranks recent reinforced entities highest", () => {
    const now = Date.now();
    const stale = upsertPkbEntity({
      entityType: "project",
      canonicalName: "stale entity",
      confidence: 0.9,
    });
    // Push the stale entity's reinforcement anchor far into the past.
    const sqlite = getSqlite();
    sqlite.run(
      `UPDATE pkb_entities SET last_reinforced_at = ?, last_seen_at = ? WHERE id = ?`,
      [
        now - 60 * 24 * 60 * 60 * 1000,
        now - 60 * 24 * 60 * 60 * 1000,
        stale.id,
      ],
    );
    const fresh = upsertPkbEntity({
      entityType: "project",
      canonicalName: "fresh entity",
      confidence: 0.5,
    });
    const scored = scorePkbEntities({ now, limit: 10 });
    expect(scored[0]!.entity.id).toBe(fresh.id);
    expect(scored[1]!.entity.id).toBe(stale.id);
  });

  test("entity provenance is appended and capped", () => {
    let last: ReturnType<typeof upsertPkbEntity> | undefined;
    for (let i = 0; i < 25; i += 1) {
      last = upsertPkbEntity({
        entityType: "project",
        canonicalName: "repeatedly reinforced",
        confidence: 0.6,
        provenance: {
          source: "perception",
          sourceEventId: `evt-${i}`,
          observedAt: 1000 + i,
        },
      });
    }
    const provenance = JSON.parse(last!.provenanceJson) as Array<{
      sourceEventId: string;
    }>;
    expect(provenance).toHaveLength(20);
    expect(provenance.at(-1)?.sourceEventId).toBe("evt-24");
    expect(last!.evidenceCount).toBe(25);
  });
});
