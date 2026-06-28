/**
 * Tests for `find-similar-skills.ts` — the read-only `find_similar_skills` tool.
 *
 * The tool's shortlist + catalog seams are dependency-injected via `deps`, so
 * these tests exercise the input validation, the catalog name/description join,
 * and the `limit` pass-through without Qdrant. Coverage:
 *   - Maps each shortlist hit to its catalog name/description and score.
 *   - Drops a shortlist hit whose id is absent from the catalog.
 *   - Passes `limit` through to the shortlist (and defaults when omitted).
 *   - Rejects a missing/blank goal and a non-positive-integer limit.
 */

import { describe, expect, mock, test } from "bun:test";

mock.module("../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

import type { ToolContext } from "../types.js";
import { executeFindSimilarSkills } from "./find-similar-skills.js";

function makeContext(): ToolContext {
  return {
    workingDir: "/tmp",
    conversationId: "test-conversation",
    trustClass: "guardian",
  };
}

const catalog = (
  ...skills: { id: string; name: string; description: string }[]
) => skills;

describe("find_similar_skills — enrichment", () => {
  test("maps each hit to its catalog name/description and score", async () => {
    const result = await executeFindSimilarSkills(
      { goal: "ship the web app" },
      makeContext(),
      {
        nearestExistingSkills: async () => [
          { skillId: "deploy-web", score: 0.91 },
          { skillId: "clean-disk", score: 0.7 },
        ],
        loadCatalog: () =>
          catalog(
            {
              id: "deploy-web",
              name: "Deploy Web",
              description: "Ship the web app to prod",
            },
            {
              id: "clean-disk",
              name: "Clean Disk",
              description: "Free up disk space",
            },
          ),
      },
    );

    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content)).toEqual({
      skills: [
        {
          skill_id: "deploy-web",
          name: "Deploy Web",
          description: "Ship the web app to prod",
          score: 0.91,
        },
        {
          skill_id: "clean-disk",
          name: "Clean Disk",
          description: "Free up disk space",
          score: 0.7,
        },
      ],
    });
  });

  test("drops a shortlist hit whose id is not in the catalog", async () => {
    const result = await executeFindSimilarSkills(
      { goal: "do the thing" },
      makeContext(),
      {
        nearestExistingSkills: async () => [
          { skillId: "present", score: 0.9 },
          { skillId: "missing", score: 0.8 },
        ],
        loadCatalog: () =>
          catalog({
            id: "present",
            name: "Present",
            description: "Exists in catalog",
          }),
      },
    );

    expect(JSON.parse(result.content)).toEqual({
      skills: [
        {
          skill_id: "present",
          name: "Present",
          description: "Exists in catalog",
          score: 0.9,
        },
      ],
    });
  });

  test("empty shortlist → empty skills array", async () => {
    const result = await executeFindSimilarSkills(
      { goal: "nothing matches" },
      makeContext(),
      {
        nearestExistingSkills: async () => [],
        loadCatalog: () => catalog(),
      },
    );

    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content)).toEqual({ skills: [] });
  });
});

describe("find_similar_skills — limit pass-through", () => {
  test("forwards an explicit limit to the shortlist", async () => {
    let seenLimit: number | undefined;
    await executeFindSimilarSkills({ goal: "g", limit: 3 }, makeContext(), {
      nearestExistingSkills: async (_goal, opts) => {
        seenLimit = opts?.limit;
        return [];
      },
      loadCatalog: () => catalog(),
    });

    expect(seenLimit).toBe(3);
  });

  test("leaves the limit unset when omitted (shortlist owns the default)", async () => {
    let seenLimit: number | undefined = -1;
    await executeFindSimilarSkills({ goal: "g" }, makeContext(), {
      nearestExistingSkills: async (_goal, opts) => {
        seenLimit = opts?.limit;
        return [];
      },
      loadCatalog: () => catalog(),
    });

    expect(seenLimit).toBeUndefined();
  });
});

describe("find_similar_skills — input validation", () => {
  test("rejects a missing goal", async () => {
    const result = await executeFindSimilarSkills({}, makeContext());
    expect(result.isError).toBe(true);
    expect(result.content).toContain("goal is required");
  });

  test("rejects a blank goal", async () => {
    const result = await executeFindSimilarSkills(
      { goal: "   " },
      makeContext(),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("goal is required");
  });

  test("rejects a non-positive-integer limit", async () => {
    for (const limit of [0, -1, 2.5, "5"]) {
      const result = await executeFindSimilarSkills(
        { goal: "g", limit },
        makeContext(),
      );
      expect(result.isError).toBe(true);
      expect(result.content).toContain("limit must be a positive integer");
    }
  });
});
