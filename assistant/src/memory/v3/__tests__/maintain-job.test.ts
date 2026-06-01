import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { setOverridesForTesting } from "../../../__tests__/feature-flag-test-helpers.js";
import type { AssistantConfig } from "../../../config/types.js";
import type { MemoryJob } from "../../jobs-store.js";
import { readPage, writePage } from "../../v2/page-store.js";
import type { ConceptPage } from "../../v2/types.js";
import type { AssignPageResult, AssignPagesOptions } from "../assign.js";
import {
  type ClassifyCandidate,
  computeClassifyTargets,
  maintainJob,
  type MaintainJobDeps,
} from "../maintain-job.js";
import type { LeafNode, LeafPath, LeafTree, Slug } from "../types.js";

const FLAG_SHADOW = "memory-v3-shadow";
const FLAG_LIVE = "memory-v3-live";

// The flag resolver ignores the passed config and reads the override cache; the
// config arg only satisfies the signature. Flags are driven via
// `setOverridesForTesting` below.
const CONFIG = {} as AssistantConfig;

function makeLeaf(path: LeafPath): LeafNode {
  return {
    path,
    frontmatter: { path, in_core: false },
    description: `${path} description`,
    members: [],
    domain: path.split("/")[0],
  };
}

function makeTree(paths: LeafPath[]): LeafTree {
  const leaves = new Map<LeafPath, LeafNode>();
  for (const path of paths) leaves.set(path, makeLeaf(path));
  return { leaves, byPage: new Map<Slug, LeafPath[]>() };
}

function makePage(slug: string, leaves?: string[]): ConceptPage {
  return {
    slug,
    frontmatter: {
      summary: `Summary for ${slug}`,
      edges: [],
      ref_files: [],
      ref_urls: [],
      leaves,
    },
    body: `Body content for ${slug}`,
  };
}

const JOB = { id: "job-1", type: "memory_v3_maintain" } as unknown as MemoryJob;

describe("maintainJob", () => {
  let workspaceDir: string;

  beforeEach(async () => {
    workspaceDir = await mkdtemp(join(tmpdir(), "v3-maintain-"));
  });

  afterEach(async () => {
    setOverridesForTesting({});
    await rm(workspaceDir, { recursive: true, force: true });
  });

  function deps(overrides: Partial<MaintainJobDeps> = {}): {
    deps: MaintainJobDeps;
    calls: { assign: number; invalidate: number; commit: number };
  } {
    const calls = { assign: 0, invalidate: 0, commit: 0 };
    const base: MaintainJobDeps = {
      workspaceDir,
      loadTree: async () => makeTree(["domain/topic-a", "domain/topic-b"]),
      assignPages: async (
        _opts: AssignPagesOptions,
      ): Promise<AssignPageResult[]> => {
        calls.assign += 1;
        return [];
      },
      selectClassifyTargets: async () => [],
      commitClassifyHighWater: () => {
        calls.commit += 1;
      },
      invalidateLanes: () => {
        calls.invalidate += 1;
      },
    };
    return { deps: { ...base, ...overrides }, calls };
  }

  test("no-op when both v3 flags are off", async () => {
    setOverridesForTesting({ [FLAG_SHADOW]: false, [FLAG_LIVE]: false });
    const { deps: d, calls } = deps();
    const outcome = await maintainJob(JOB, CONFIG, d);
    expect(outcome.disabled).toBe(true);
    expect(calls.assign).toBe(0);
    expect(calls.invalidate).toBe(0);
  });

  test("runs assign + invalidate when shadow flag is on", async () => {
    setOverridesForTesting({ [FLAG_SHADOW]: true });
    const { deps: d, calls } = deps();
    const outcome = await maintainJob(JOB, CONFIG, d);
    expect(outcome.disabled).toBe(false);
    expect(calls.assign).toBe(1);
    expect(calls.invalidate).toBe(1);
    expect(outcome.invalidated).toBe(true);
  });

  test("runs when only the live flag is on", async () => {
    setOverridesForTesting({ [FLAG_LIVE]: true });
    const { deps: d, calls } = deps();
    await maintainJob(JOB, CONFIG, d);
    expect(calls.assign).toBe(1);
    expect(calls.invalidate).toBe(1);
  });

  test("counts pages newly assigned by the classify-union stage", async () => {
    setOverridesForTesting({ [FLAG_SHADOW]: true });
    const { deps: d } = deps({
      assignPages: async () => [
        { slug: "p1", before: [], after: ["domain/topic-a"], failed: false },
        { slug: "p2", before: [], after: [], failed: true },
        {
          slug: "p3",
          before: ["domain/topic-a"],
          after: ["domain/topic-a"],
          failed: false,
        },
      ],
    });
    const outcome = await maintainJob(JOB, CONFIG, d);
    expect(outcome.assigned).toBe(1);
  });

  test("prune drops dangling leaf refs and rewrites the page", async () => {
    setOverridesForTesting({ [FLAG_SHADOW]: true });
    await writePage(
      workspaceDir,
      makePage("dangling", ["domain/topic-a", "domain/gone"]),
    );
    await writePage(workspaceDir, makePage("clean", ["domain/topic-b"]));
    await writePage(workspaceDir, makePage("empty", []));

    const { deps: d } = deps();
    const outcome = await maintainJob(JOB, CONFIG, d);

    expect(outcome.pruned).toBe(1);
    expect(outcome.prunedRefs).toBe(1);

    const dangling = await readPage(workspaceDir, "dangling");
    expect(dangling?.frontmatter.leaves).toEqual(["domain/topic-a"]);

    const clean = await readPage(workspaceDir, "clean");
    expect(clean?.frontmatter.leaves).toEqual(["domain/topic-b"]);
  });

  test("contains an assign failure without aborting prune or invalidate", async () => {
    setOverridesForTesting({ [FLAG_SHADOW]: true });
    await writePage(
      workspaceDir,
      makePage("dangling", ["domain/topic-a", "domain/gone"]),
    );
    const { deps: d, calls } = deps({
      assignPages: async () => {
        throw new Error("assign boom");
      },
    });
    const outcome = await maintainJob(JOB, CONFIG, d);
    expect(outcome.failures).toContain("assign");
    expect(outcome.pruned).toBe(1);
    expect(calls.invalidate).toBe(1);
    expect(outcome.invalidated).toBe(true);
  });

  test("contains a tree-load failure but still invalidates lanes", async () => {
    setOverridesForTesting({ [FLAG_SHADOW]: true });
    const { deps: d, calls } = deps({
      loadTree: async () => {
        throw new Error("load boom");
      },
    });
    const outcome = await maintainJob(JOB, CONFIG, d);
    expect(outcome.failures).toContain("load_tree");
    expect(calls.assign).toBe(0);
    expect(calls.invalidate).toBe(1);
  });

  test("classifies the selected delta targets (passes them to assignPages)", async () => {
    setOverridesForTesting({ [FLAG_SHADOW]: true });
    let seenSlugs: Slug[] | undefined;
    const { deps: d } = deps({
      selectClassifyTargets: async () => ["p-new", "p-edited"],
      assignPages: async (opts: AssignPagesOptions) => {
        seenSlugs = opts.slugs;
        return [];
      },
    });
    await maintainJob(JOB, CONFIG, d);
    expect(seenSlugs).toEqual(["p-new", "p-edited"]);
  });

  test("advances the high-water mark after a successful classify pass", async () => {
    setOverridesForTesting({ [FLAG_SHADOW]: true });
    const { deps: d, calls } = deps();
    await maintainJob(JOB, CONFIG, d);
    expect(calls.commit).toBe(1);
  });

  test("does not advance the high-water mark when classify throws", async () => {
    setOverridesForTesting({ [FLAG_SHADOW]: true });
    const { deps: d, calls } = deps({
      assignPages: async () => {
        throw new Error("assign boom");
      },
    });
    const outcome = await maintainJob(JOB, CONFIG, d);
    expect(outcome.failures).toContain("assign");
    expect(calls.commit).toBe(0);
  });
});

describe("computeClassifyTargets", () => {
  const page = (
    slug: string,
    modifiedAt: number,
    leaves: string[] = [],
  ): ClassifyCandidate => ({ slug, modifiedAt, leaves });

  test("first run (null high-water) classifies only unassigned pages", () => {
    const targets = computeClassifyTargets(
      [page("unassigned", 100, []), page("assigned-recent", 200, ["domain/a"])],
      null,
    );
    expect(targets).toEqual(["unassigned"]);
  });

  test("re-classifies an already-assigned page edited since the high-water", () => {
    const targets = computeClassifyTargets(
      [page("assigned-edited", 300, ["domain/a"])],
      200,
    );
    expect(targets).toEqual(["assigned-edited"]);
  });

  test("skips an assigned page untouched since the high-water (no self-trigger / drift)", () => {
    const targets = computeClassifyTargets(
      [page("assigned-stale", 150, ["domain/a"])],
      200,
    );
    expect(targets).toEqual([]);
  });

  test("still classifies unassigned pages regardless of mtime", () => {
    const targets = computeClassifyTargets(
      [page("unassigned-old", 10, [])],
      200,
    );
    expect(targets).toEqual(["unassigned-old"]);
  });

  test("excludes synthetic skill/CLI rows (modifiedAt 0) despite empty leaves", () => {
    const targets = computeClassifyTargets(
      [page("skills/meet-join", 0, []), page("real", 300, [])],
      200,
    );
    expect(targets).toEqual(["real"]);
  });

  test("targets = unassigned ∪ recently-edited, excluding assigned-and-stale", () => {
    const targets = computeClassifyTargets(
      [
        page("unassigned-old", 10, []),
        page("assigned-stale", 150, ["domain/a"]),
        page("assigned-fresh", 300, ["domain/a"]),
        page("skills/x", 0, []),
      ],
      200,
    );
    expect(targets).toEqual(["unassigned-old", "assigned-fresh"]);
  });
});
