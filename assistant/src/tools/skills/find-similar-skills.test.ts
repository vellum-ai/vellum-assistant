/**
 * Tests for `find-similar-skills.ts` — the read-only `find_similar_skills` tool.
 *
 * The tool's shortlist + catalog seams are dependency-injected via `deps`, so
 * these tests exercise the input validation, the catalog name/description join,
 * and the `limit` pass-through without Qdrant. Coverage:
 *   - Maps each shortlist hit to its catalog name/description/source and score.
 *   - Joins install-meta `author` onto managed hits (and omits it elsewhere).
 *   - Drops a shortlist hit whose id is absent from the catalog.
 *   - Passes `limit` through to the shortlist (and defaults when omitted).
 *   - Rejects a missing/blank goal and a non-positive-integer limit.
 *
 * Managed-author resolution reads install-meta off the filesystem, so the
 * `readInstallMeta` seam is mocked to key off the skill id (its dir basename).
 */

import { basename } from "node:path";
import { describe, expect, mock, test } from "bun:test";

import type { SkillSource } from "../../config/skills.js";
import type { OwnerInfo } from "../types.js";

// Map managed skill id → recorded author, consulted by the mocked
// `readInstallMeta` below. Tests set entries to drive the author join.
const installMetaAuthors: Record<string, "assistant" | "user" | undefined> = {};

mock.module("../../skills/install-meta.js", () => ({
  readInstallMeta: (skillDir: string) => {
    const author = installMetaAuthors[basename(skillDir)];
    return author ? { origin: "managed", installedAt: "", author } : null;
  },
}));

import type { ToolContext } from "../types.js";
import { executeFindSimilarSkills } from "./find-similar-skills.js";

function makeContext(enabledPluginSet?: Set<string> | null): ToolContext {
  return {
    workingDir: "/tmp",
    conversationId: "test-conversation",
    trustClass: "guardian",
    enabledPluginSet,
  };
}

const catalog = (
  ...skills: {
    id: string;
    name: string;
    description: string;
    source: SkillSource;
    owner?: OwnerInfo;
  }[]
) => skills;

describe("find_similar_skills — enrichment", () => {
  test("maps each hit to its catalog name/description/source and score", async () => {
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
              source: "managed",
            },
            {
              id: "clean-disk",
              name: "Clean Disk",
              description: "Free up disk space",
              source: "bundled",
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
          source: "managed",
          score: 0.91,
        },
        {
          skill_id: "clean-disk",
          name: "Clean Disk",
          description: "Free up disk space",
          source: "bundled",
          score: 0.7,
        },
      ],
    });
  });

  test("joins install-meta author onto managed hits, omits it elsewhere", async () => {
    installMetaAuthors["mine"] = "assistant";
    installMetaAuthors["theirs"] = "user";
    // `untagged` and `bundled-hit` intentionally have no install-meta entry.

    try {
      const result = await executeFindSimilarSkills(
        { goal: "do the procedure" },
        makeContext(),
        {
          nearestExistingSkills: async () => [
            { skillId: "mine", score: 0.95 },
            { skillId: "theirs", score: 0.9 },
            { skillId: "untagged", score: 0.85 },
            { skillId: "bundled-hit", score: 0.8 },
          ],
          loadCatalog: () =>
            catalog(
              {
                id: "mine",
                name: "Mine",
                description: "Assistant-authored managed skill",
                source: "managed",
              },
              {
                id: "theirs",
                name: "Theirs",
                description: "User-authored managed skill",
                source: "managed",
              },
              {
                id: "untagged",
                name: "Untagged",
                description: "Managed skill with no recorded author",
                source: "managed",
              },
              {
                id: "bundled-hit",
                name: "Bundled Hit",
                description: "A bundled skill",
                source: "bundled",
              },
            ),
        },
      );

      expect(result.isError).toBe(false);
      const skills = JSON.parse(result.content).skills as {
        skill_id: string;
        author?: string;
      }[];
      const byId = Object.fromEntries(skills.map((s) => [s.skill_id, s]));

      // Managed `author:"assistant"` → overwritable by the retrospective.
      expect(byId["mine"].author).toBe("assistant");
      // Managed `author:"user"` → off-limits; the signal lets the caller skip.
      expect(byId["theirs"].author).toBe("user");
      // Managed but untagged → author omitted (undefined survives as absent key).
      expect("author" in byId["untagged"]).toBe(false);
      // Non-managed source → author never read.
      expect("author" in byId["bundled-hit"]).toBe(false);
    } finally {
      delete installMetaAuthors["mine"];
      delete installMetaAuthors["theirs"];
    }
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
            source: "plugin",
          }),
      },
    );

    expect(JSON.parse(result.content)).toEqual({
      skills: [
        {
          skill_id: "present",
          name: "Present",
          description: "Exists in catalog",
          source: "plugin",
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

describe("find_similar_skills — per-chat plugin scope", () => {
  const SHORTLIST = [
    { skillId: "core-skill", score: 0.9 },
    { skillId: "plug-skill", score: 0.8 },
  ];
  const CATALOG = () =>
    catalog(
      {
        id: "core-skill",
        name: "Core Skill",
        description: "A bundled skill",
        source: "bundled",
      },
      {
        id: "plug-skill",
        name: "Plugin Skill",
        description: "Owned by plugin p",
        source: "plugin",
        owner: { kind: "plugin", id: "p" },
      },
    );

  test("drops a plugin skill whose owner is outside the effective set", async () => {
    const result = await executeFindSimilarSkills(
      { goal: "do the thing" },
      makeContext(new Set(["other"])),
      {
        nearestExistingSkills: async () => SHORTLIST,
        loadCatalog: CATALOG,
      },
    );

    const ids = (
      JSON.parse(result.content).skills as { skill_id: string }[]
    ).map((s) => s.skill_id);
    expect(ids).toContain("core-skill");
    expect(ids).not.toContain("plug-skill");
  });

  test("keeps a plugin skill whose owner is in the effective set", async () => {
    const result = await executeFindSimilarSkills(
      { goal: "do the thing" },
      makeContext(new Set(["p"])),
      {
        nearestExistingSkills: async () => SHORTLIST,
        loadCatalog: CATALOG,
      },
    );

    const ids = (
      JSON.parse(result.content).skills as { skill_id: string }[]
    ).map((s) => s.skill_id);
    expect(ids).toContain("core-skill");
    expect(ids).toContain("plug-skill");
  });

  test("null set (no restriction) keeps every skill", async () => {
    const result = await executeFindSimilarSkills(
      { goal: "do the thing" },
      makeContext(null),
      {
        nearestExistingSkills: async () => SHORTLIST,
        loadCatalog: CATALOG,
      },
    );

    const ids = (
      JSON.parse(result.content).skills as { skill_id: string }[]
    ).map((s) => s.skill_id);
    expect(ids).toEqual(["core-skill", "plug-skill"]);
  });

  test("fills the limit with in-scope skills when top matches are out of scope", async () => {
    // The two highest-scoring matches are owned by an out-of-scope plugin "q";
    // the next two are in scope. With limit=2, a filter applied AFTER the limit
    // would slice off plug-hi-1/plug-hi-2, then drop both → an empty result.
    // The fix filters the candidate catalog BEFORE the limit, so the slice
    // lands on the two in-scope skills instead.
    const FULL_CATALOG = () =>
      catalog(
        {
          id: "plug-hi-1",
          name: "Plugin Hi 1",
          description: "High-rank, out of scope",
          source: "plugin",
          owner: { kind: "plugin", id: "q" },
        },
        {
          id: "plug-hi-2",
          name: "Plugin Hi 2",
          description: "High-rank, out of scope",
          source: "plugin",
          owner: { kind: "plugin", id: "q" },
        },
        {
          id: "core-lo-1",
          name: "Core Lo 1",
          description: "Lower-rank, in scope",
          source: "bundled",
        },
        {
          id: "core-lo-2",
          name: "Core Lo 2",
          description: "Lower-rank, in scope",
          source: "bundled",
        },
      );

    // Mimics the real `nearestExistingSkills`: rank the candidate catalog the
    // caller passes via `loadCatalog`, then slice to `limit`. Pre-fix the tool
    // passed the full catalog (so the top-K limit hit out-of-scope skills);
    // post-fix it passes a scope-filtered catalog.
    const RANKED = [
      { skillId: "plug-hi-1", score: 0.98 },
      { skillId: "plug-hi-2", score: 0.97 },
      { skillId: "core-lo-1", score: 0.5 },
      { skillId: "core-lo-2", score: 0.4 },
    ];
    const rankThenLimit = async (
      _goal: string,
      opts?: {
        limit?: number;
        loadCatalog?: () => { id: string }[] | Promise<{ id: string }[]>;
      },
    ) => {
      const candidateIds = new Set(
        (await (opts?.loadCatalog?.() ?? FULL_CATALOG())).map((s) => s.id),
      );
      return RANKED.filter((h) => candidateIds.has(h.skillId)).slice(
        0,
        opts?.limit ?? RANKED.length,
      );
    };

    const result = await executeFindSimilarSkills(
      { goal: "do the thing", limit: 2 },
      makeContext(new Set(["p"])), // plugin "q" is out of scope
      {
        nearestExistingSkills: rankThenLimit,
        loadCatalog: FULL_CATALOG,
      },
    );

    const ids = (
      JSON.parse(result.content).skills as { skill_id: string }[]
    ).map((s) => s.skill_id);
    // The limit is honored AND filled with in-scope skills, not starved to empty.
    expect(ids).toEqual(["core-lo-1", "core-lo-2"]);
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
