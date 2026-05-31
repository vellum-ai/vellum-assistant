import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { AssistantConfig } from "../../../config/types.js";
import type { MemoryJob } from "../../jobs-store.js";
import { readPage, writePage } from "../../v2/page-store.js";
import type { ConceptPage } from "../../v2/types.js";
import type { AssignPageResult, AssignPagesOptions } from "../assign.js";
import { maintainJob, type MaintainJobDeps } from "../maintain-job.js";
import type { LeafNode, LeafPath, LeafTree, Slug } from "../types.js";

const FLAG_SHADOW = "memory-v3-shadow";
const FLAG_LIVE = "memory-v3-live";

function configWithFlags(flags: Record<string, boolean>): AssistantConfig {
  return {
    featureFlags: Object.entries(flags).map(([name, enabled]) => ({
      name,
      enabled,
    })),
  } as unknown as AssistantConfig;
}

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
    frontmatter: { summary: `Summary for ${slug}`, edges: [], leaves },
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
    await rm(workspaceDir, { recursive: true, force: true });
  });

  function deps(overrides: Partial<MaintainJobDeps> = {}): {
    deps: MaintainJobDeps;
    calls: { assign: number; invalidate: number };
  } {
    const calls = { assign: 0, invalidate: 0 };
    const base: MaintainJobDeps = {
      workspaceDir,
      loadTree: async () => makeTree(["domain/topic-a", "domain/topic-b"]),
      assignPages: async (
        _opts: AssignPagesOptions,
      ): Promise<AssignPageResult[]> => {
        calls.assign += 1;
        return [];
      },
      invalidateLanes: () => {
        calls.invalidate += 1;
      },
    };
    return { deps: { ...base, ...overrides }, calls };
  }

  test("no-op when both v3 flags are off", async () => {
    const { deps: d, calls } = deps();
    const outcome = await maintainJob(
      JOB,
      configWithFlags({ [FLAG_SHADOW]: false, [FLAG_LIVE]: false }),
      d,
    );
    expect(outcome.disabled).toBe(true);
    expect(calls.assign).toBe(0);
    expect(calls.invalidate).toBe(0);
  });

  test("runs assign + invalidate when shadow flag is on", async () => {
    const { deps: d, calls } = deps();
    const outcome = await maintainJob(
      JOB,
      configWithFlags({ [FLAG_SHADOW]: true }),
      d,
    );
    expect(outcome.disabled).toBe(false);
    expect(calls.assign).toBe(1);
    expect(calls.invalidate).toBe(1);
    expect(outcome.invalidated).toBe(true);
  });

  test("runs when only the live flag is on", async () => {
    const { deps: d, calls } = deps();
    await maintainJob(JOB, configWithFlags({ [FLAG_LIVE]: true }), d);
    expect(calls.assign).toBe(1);
    expect(calls.invalidate).toBe(1);
  });

  test("counts pages newly assigned by the classify-union stage", async () => {
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
    const outcome = await maintainJob(
      JOB,
      configWithFlags({ [FLAG_SHADOW]: true }),
      d,
    );
    expect(outcome.assigned).toBe(1);
  });

  test("prune drops dangling leaf refs and rewrites the page", async () => {
    await writePage(
      workspaceDir,
      makePage("dangling", ["domain/topic-a", "domain/gone"]),
    );
    await writePage(workspaceDir, makePage("clean", ["domain/topic-b"]));
    await writePage(workspaceDir, makePage("empty", []));

    const { deps: d } = deps();
    const outcome = await maintainJob(
      JOB,
      configWithFlags({ [FLAG_SHADOW]: true }),
      d,
    );

    expect(outcome.pruned).toBe(1);
    expect(outcome.prunedRefs).toBe(1);

    const dangling = await readPage(workspaceDir, "dangling");
    expect(dangling?.frontmatter.leaves).toEqual(["domain/topic-a"]);

    const clean = await readPage(workspaceDir, "clean");
    expect(clean?.frontmatter.leaves).toEqual(["domain/topic-b"]);
  });

  test("contains an assign failure without aborting prune or invalidate", async () => {
    await writePage(
      workspaceDir,
      makePage("dangling", ["domain/topic-a", "domain/gone"]),
    );
    const { deps: d, calls } = deps({
      assignPages: async () => {
        throw new Error("assign boom");
      },
    });
    const outcome = await maintainJob(
      JOB,
      configWithFlags({ [FLAG_SHADOW]: true }),
      d,
    );
    expect(outcome.failures).toContain("assign");
    expect(outcome.pruned).toBe(1);
    expect(calls.invalidate).toBe(1);
    expect(outcome.invalidated).toBe(true);
  });

  test("contains a tree-load failure but still invalidates lanes", async () => {
    const { deps: d, calls } = deps({
      loadTree: async () => {
        throw new Error("load boom");
      },
    });
    const outcome = await maintainJob(
      JOB,
      configWithFlags({ [FLAG_SHADOW]: true }),
      d,
    );
    expect(outcome.failures).toContain("load_tree");
    expect(calls.assign).toBe(0);
    expect(calls.invalidate).toBe(1);
  });
});
