/**
 * Tests for `substrate/ingest.ts`.
 *
 * Coverage matrix:
 *   - Happy path: N valid pages written, both reindex job types enqueued once.
 *   - Dry-run: nothing on disk, no lock file, no enqueues, per-page results
 *     still reported.
 *   - Collision: existing slug skipped without `overwrite`, rewritten with it.
 *   - Malformed page (bad frontmatter YAML, schema failure, unterminated
 *     fence): `invalid` with an error string while valid batch-mates write.
 *   - Lock held by a live PID: IngestLockedError, zero writes, zero enqueues.
 *   - Batch over the cap: RangeError.
 *   - In-batch duplicate slug: later occurrence `invalid`.
 *   - Non-blocking warnings: missing `source`, unparseable `origin_date`,
 *     frontmatter `slug` differing from the storage slug, link targets
 *     neither on disk nor in the batch.
 *   - Under-lock collision snapshot: a page committed between validation and
 *     the write phase is skipped, and `listPages` runs after `tryAcquireLock`.
 *   - Partial write failure: the reindex fan-out still runs for committed
 *     pages while the write error propagates.
 *
 * Tests use temp workspaces (mkdtemp) and never touch `~/.vellum/`. Sample
 * content uses generic placeholders (Alice).
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// ── jobs-store mock ─────────────────────────────────────────────────
//
// The ingest service enqueues reindex follow-ups through the shared memory
// job queue; an in-memory recorder stands in for the DB so the tests can
// assert the fan-out without initializing sqlite.
const enqueuedJobs: Array<{
  type: string;
  payload: Record<string, unknown>;
}> = [];
let nextJobIdCounter = 0;
// Job types the service should see as already pending; drives the
// enqueue-coalescing branch (`hasPendingJobOfType`).
let pendingJobTypes = new Set<string>();

mock.module("../../../../../persistence/jobs-store.js", () => ({
  enqueueMemoryJob: (
    type: string,
    payload: Record<string, unknown>,
  ): string => {
    enqueuedJobs.push({ type, payload });
    nextJobIdCounter += 1;
    return `job-${nextJobIdCounter}`;
  },
  hasPendingJobOfType: (type: string): boolean => pendingJobTypes.has(type),
  isMemoryEnabled: () => true,
}));

// ── page-store / consolidation-lock delegating mocks ────────────────
//
// Thin wrappers around the real modules that record the ordering of lock
// acquisition vs the collision snapshot and expose two race hooks: a
// callback fired right after the lock is acquired (simulating a concurrent
// writer that committed just before the snapshot) and a set of slugs whose
// `writePage` rejects (simulating a mid-batch write failure).
//
// `mock.module` mutates the already-imported namespace objects in place, so
// the wrapped functions are snapshotted into standalone consts first; calling
// through the namespace after mocking would recurse into the wrapper.
const realPageStore = await import("../page-store.js");
const realLock = await import("../consolidation-lock.js");
const realListPages = realPageStore.listPages;
const realWritePage = realPageStore.writePage;
const realTryAcquireLock = realLock.tryAcquireLock;

const callTrace: string[] = [];
let onLockAcquired: (() => void) | undefined;
let failWriteSlugs = new Set<string>();

mock.module("../page-store.js", () => ({
  ...realPageStore,
  listPages: (workspaceDir: string): Promise<string[]> => {
    callTrace.push("listPages");
    return realListPages(workspaceDir);
  },
  writePage: (...args: Parameters<typeof realWritePage>): Promise<void> => {
    if (failWriteSlugs.has(args[1].slug)) {
      return Promise.reject(
        new Error(`simulated write failure: ${args[1].slug}`),
      );
    }
    return realWritePage(...args);
  },
}));

mock.module("../consolidation-lock.js", () => ({
  ...realLock,
  tryAcquireLock: (
    ...args: Parameters<typeof realTryAcquireLock>
  ): string | null => {
    const holder = realTryAcquireLock(...args);
    if (holder === null) {
      callTrace.push("tryAcquireLock");
      onLockAcquired?.();
    }
    return holder;
  },
}));

const { IngestLockedError, ingestPages, MAX_INGEST_PAGES_PER_CALL } =
  await import("../ingest.js");
const { getConsolidationLockPath } = await import("../consolidation-lock.js");
const { listPages, readPage } = await import("../page-store.js");

let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "memory-ingest-test-"));
  enqueuedJobs.length = 0;
  pendingJobTypes = new Set();
  callTrace.length = 0;
  onLockAcquired = undefined;
  failWriteSlugs = new Set();
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

/** A well-formed page carrying provenance so it yields zero warnings. */
function validPage(body: string): string {
  return `---\nsource: import:chatgpt\norigin_date: 2025-03-14\n---\n${body}\n`;
}

function lockPath(): string {
  return getConsolidationLockPath(join(workspace, "memory"));
}

describe("ingestPages", () => {
  test("happy path writes every page and enqueues both reindex jobs once", async () => {
    const summary = await ingestPages(workspace, [
      { slug: "people/alice", content: validPage("Alice likes hiking.") },
      { slug: "projects/garden", content: validPage("Garden redesign notes.") },
      { slug: "recipes", content: validPage("Favorite recipes.") },
    ]);

    expect(summary.written).toBe(3);
    expect(summary.skipped).toBe(0);
    expect(summary.invalid).toBe(0);
    expect(summary.dryRun).toBe(false);
    expect(summary.results.map((r) => r.action)).toEqual([
      "written",
      "written",
      "written",
    ]);
    expect(summary.results.every((r) => r.warnings.length === 0)).toBe(true);

    const alice = await readPage(workspace, "people/alice");
    expect(alice?.body.trim()).toBe("Alice likes hiking.");
    expect(alice?.frontmatter.source).toBe("import:chatgpt");
    expect(await listPages(workspace)).toEqual([
      "people/alice",
      "projects/garden",
      "recipes",
    ]);

    expect(enqueuedJobs.map((j) => j.type).sort()).toEqual([
      "memory_v2_reembed",
      "memory_v3_maintain",
    ]);
    // The lock is released after the batch.
    expect(existsSync(lockPath())).toBe(false);
  });

  test("dry-run reports per-page results without disk writes, lock, or enqueues", async () => {
    const summary = await ingestPages(
      workspace,
      [
        { slug: "people/alice", content: validPage("Alice likes hiking.") },
        { slug: "bad slug", content: validPage("whitespace slug") },
      ],
      { dryRun: true },
    );

    expect(summary.dryRun).toBe(true);
    expect(summary.written).toBe(1);
    expect(summary.invalid).toBe(1);
    expect(summary.results[0]).toMatchObject({
      slug: "people/alice",
      action: "written",
    });
    expect(summary.results[1].action).toBe("invalid");
    expect(summary.results[1].error).toContain("whitespace");

    expect(await listPages(workspace)).toEqual([]);
    expect(existsSync(lockPath())).toBe(false);
    expect(enqueuedJobs).toEqual([]);
  });

  test("existing slug is skipped without overwrite and rewritten with it", async () => {
    await ingestPages(workspace, [
      { slug: "people/alice", content: validPage("Original body.") },
    ]);
    enqueuedJobs.length = 0;

    const skipped = await ingestPages(workspace, [
      { slug: "people/alice", content: validPage("Replacement body.") },
    ]);
    expect(skipped.results[0].action).toBe("skipped_exists");
    expect(skipped.written).toBe(0);
    expect(skipped.skipped).toBe(1);
    const unchanged = await readPage(workspace, "people/alice");
    expect(unchanged?.body.trim()).toBe("Original body.");
    // Nothing written, so no reindex fan-out.
    expect(enqueuedJobs).toEqual([]);

    const overwritten = await ingestPages(
      workspace,
      [{ slug: "people/alice", content: validPage("Replacement body.") }],
      { overwrite: true },
    );
    expect(overwritten.results[0].action).toBe("written");
    const replaced = await readPage(workspace, "people/alice");
    expect(replaced?.body.trim()).toBe("Replacement body.");
  });

  test("malformed pages are invalid with an error string while valid batch-mates write", async () => {
    const summary = await ingestPages(workspace, [
      // Broken YAML inside the fence.
      { slug: "broken-yaml", content: "---\nedges: [unclosed\n---\nbody\n" },
      // Well-formed YAML that fails the frontmatter schema (edges must be an array).
      { slug: "schema-fail", content: "---\nedges: not-an-array\n---\nbody\n" },
      // Fence that opens but never closes (degraded parse).
      { slug: "unterminated", content: "---\nsource: import:chatgpt\nbody\n" },
      { slug: "good", content: validPage("Survives the batch.") },
    ]);

    expect(summary.invalid).toBe(3);
    expect(summary.written).toBe(1);
    for (const result of summary.results.slice(0, 3)) {
      expect(result.action).toBe("invalid");
      expect(typeof result.error).toBe("string");
      expect(result.error!.length).toBeGreaterThan(0);
    }
    expect(summary.results[2].error).toContain("closing --- fence is missing");

    expect(await listPages(workspace)).toEqual(["good"]);
    expect(enqueuedJobs.map((j) => j.type).sort()).toEqual([
      "memory_v2_reembed",
      "memory_v3_maintain",
    ]);
  });

  test("held lock throws IngestLockedError with the holder and writes nothing", async () => {
    const path = lockPath();
    mkdirSync(dirname(path), { recursive: true });
    const holderPayload = `${process.pid} ${Date.now()} consolidation`;
    writeFileSync(path, `${holderPayload}\n`);

    let thrown: unknown;
    try {
      await ingestPages(workspace, [
        { slug: "people/alice", content: validPage("Alice likes hiking.") },
      ]);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(IngestLockedError);
    expect((thrown as InstanceType<typeof IngestLockedError>).holder).toBe(
      holderPayload,
    );

    expect(await listPages(workspace)).toEqual([]);
    expect(enqueuedJobs).toEqual([]);
    // The pre-existing lock is left in place for its holder.
    expect(existsSync(path)).toBe(true);
  });

  test("batch over the cap throws RangeError before any validation", async () => {
    const pages = Array.from(
      { length: MAX_INGEST_PAGES_PER_CALL + 1 },
      (_, i) => ({ slug: `page-${i}`, content: validPage(`Body ${i}.`) }),
    );
    await expect(ingestPages(workspace, pages)).rejects.toBeInstanceOf(
      RangeError,
    );
    expect(await listPages(workspace)).toEqual([]);
  });

  test("in-batch duplicate slug is invalid; the first occurrence wins", async () => {
    const summary = await ingestPages(workspace, [
      { slug: "people/alice", content: validPage("First occurrence.") },
      { slug: "people/alice", content: validPage("Second occurrence.") },
    ]);

    expect(summary.written).toBe(1);
    expect(summary.invalid).toBe(1);
    expect(summary.results[1].action).toBe("invalid");
    expect(summary.results[1].error).toContain("duplicate slug");
    const page = await readPage(workspace, "people/alice");
    expect(page?.body.trim()).toBe("First occurrence.");
  });

  test("slugs under synthetic capability prefixes are invalid, not written", async () => {
    const summary = await ingestPages(workspace, [
      { slug: "skills/browser", content: validPage("Shadowed skill page.") },
      { slug: "cli-commands/memory", content: validPage("Shadowed CLI page.") },
      { slug: "people/alice", content: validPage("Normal page.") },
    ]);

    expect(summary.written).toBe(1);
    expect(summary.invalid).toBe(2);
    expect(summary.results[0].action).toBe("invalid");
    expect(summary.results[0].error).toContain("reserved for synthetic");
    expect(summary.results[1].action).toBe("invalid");
    expect(await readPage(workspace, "skills/browser")).toBeNull();
    expect(await readPage(workspace, "cli-commands/memory")).toBeNull();
    expect(await readPage(workspace, "people/alice")).not.toBeNull();
  });

  test("missing source and unparseable origin_date produce warnings, not failures", async () => {
    const summary = await ingestPages(workspace, [
      { slug: "no-source", content: "---\nedges: []\n---\nNo provenance.\n" },
      {
        slug: "bad-date",
        content:
          "---\nsource: import:chatgpt\norigin_date: sometime last spring\n---\nBody.\n",
      },
    ]);

    expect(summary.written).toBe(2);
    expect(summary.invalid).toBe(0);
    expect(summary.results[0].warnings.join(" ")).toContain("source");
    expect(summary.results[1].warnings.join(" ")).toContain("origin_date");
  });

  test("frontmatter slug differing from the storage slug warns without blocking the write", async () => {
    const summary = await ingestPages(workspace, [
      {
        slug: "people/alice",
        content:
          "---\nsource: import:chatgpt\norigin_date: 2025-03-14\nslug: people/alicia\n---\nBody.\n",
      },
      {
        slug: "people/bob",
        content:
          "---\nsource: import:chatgpt\norigin_date: 2025-03-14\nslug: people/bob\n---\nBody.\n",
      },
    ]);

    expect(summary.written).toBe(2);
    expect(summary.invalid).toBe(0);
    const mismatch = summary.results[0].warnings.join(" ");
    expect(mismatch).toContain("people/alicia");
    expect(mismatch).toContain("people/alice");
    expect(mismatch).toContain("storage slug");
    // A matching frontmatter slug stays silent.
    expect(summary.results[1].warnings).toEqual([]);
    // The page lands under the storage slug regardless of the warning.
    expect(await listPages(workspace)).toEqual(["people/alice", "people/bob"]);
  });

  test("link targets neither on disk nor in the batch warn without blocking the write", async () => {
    // `people/bob` already exists on disk; `projects/garden` arrives in the
    // same batch; `atl-1291` and `ghost` exist nowhere.
    await ingestPages(workspace, [
      { slug: "people/bob", content: validPage("Bob.") },
    ]);
    enqueuedJobs.length = 0;

    const summary = await ingestPages(workspace, [
      {
        slug: "people/alice",
        content:
          "---\nsource: import:chatgpt\norigin_date: 2025-03-14\n" +
          "links:\n  - people/bob\n  - projects/garden\n  - atl-1291\n" +
          "edges: [ghost]\n---\n" +
          "Alice mentions [[projects/garden]] and [[people/bob]] and [[skills/deploy]].\n",
      },
      { slug: "projects/garden", content: validPage("Garden.") },
    ]);

    expect(summary.written).toBe(2);
    expect(summary.invalid).toBe(0);
    const [alice, garden] = summary.results;
    expect(alice.action).toBe("written");
    expect(alice.warnings).toHaveLength(1);
    // Every unresolved target on one line, sorted; targets that resolve on
    // disk, in the batch, or under a synthetic prefix stay silent.
    expect(alice.warnings[0]).toContain(
      "link targets not on disk or in this batch: atl-1291, ghost",
    );
    expect(alice.warnings[0]).not.toContain("people/bob");
    expect(alice.warnings[0]).not.toContain("projects/garden");
    expect(alice.warnings[0]).not.toContain("skills/deploy");
    expect(garden.warnings).toEqual([]);
    // Written regardless, and reindexed.
    expect(await readPage(workspace, "people/alice")).not.toBeNull();
    expect(enqueuedJobs.map((j) => j.type).sort()).toEqual([
      "memory_v2_reembed",
      "memory_v3_maintain",
    ]);
  });

  test("dangling-link warnings are reported on dry-run and skipped for pages the batch will not write", async () => {
    await ingestPages(workspace, [
      { slug: "people/bob", content: validPage("Bob.") },
    ]);

    const summary = await ingestPages(
      workspace,
      [
        {
          slug: "people/alice",
          content: validPage("Alice mentions [[nowhere]]."),
        },
        // Exists on disk and overwrite is off, so this content is never
        // written; its dangling link is not this batch's business.
        {
          slug: "people/bob",
          content: validPage("Bob mentions [[also-nowhere]]."),
        },
      ],
      { dryRun: true },
    );

    expect(summary.results[0].action).toBe("written");
    expect(summary.results[0].warnings.join(" ")).toContain("nowhere");
    expect(summary.results[1].action).toBe("skipped_exists");
    expect(summary.results[1].warnings).toEqual([]);
    expect(await readPage(workspace, "people/alice")).toBeNull();
  });

  test("a pending reindex job of the same type suppresses its duplicate enqueue", async () => {
    pendingJobTypes = new Set(["memory_v2_reembed"]);
    await ingestPages(workspace, [
      { slug: "people/alice", content: validPage("Alice likes hiking.") },
    ]);
    expect(enqueuedJobs.map((j) => j.type)).toEqual(["memory_v3_maintain"]);
  });

  test("a page committed during lock acquisition is skipped, not overwritten", async () => {
    // Simulated concurrent writer: the colliding page lands on disk after
    // validation ran and right after the lock is acquired, so only an
    // under-lock snapshot can see it.
    onLockAcquired = () => {
      const path = join(workspace, "memory", "concepts", "people", "alice.md");
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, validPage("Concurrent writer body."));
    };

    const summary = await ingestPages(workspace, [
      { slug: "people/alice", content: validPage("Ingest body.") },
    ]);

    // The collision snapshot ran after lock acquisition.
    expect(callTrace).toEqual(["tryAcquireLock", "listPages"]);
    expect(summary.results[0].action).toBe("skipped_exists");
    expect(summary.written).toBe(0);
    expect(summary.skipped).toBe(1);
    const preserved = await readPage(workspace, "people/alice");
    expect(preserved?.body.trim()).toBe("Concurrent writer body.");
    // Nothing written, so no reindex fan-out; the lock is released.
    expect(enqueuedJobs).toEqual([]);
    expect(existsSync(lockPath())).toBe(false);
  });

  test("dry-run takes its advisory snapshot without touching the lock", async () => {
    await ingestPages(
      workspace,
      [{ slug: "people/alice", content: validPage("Alice likes hiking.") }],
      { dryRun: true },
    );
    expect(callTrace).toEqual(["listPages"]);
  });

  test("a mid-batch write failure still enqueues reindex follow-ups for committed pages", async () => {
    failWriteSlugs = new Set(["projects/garden"]);

    let thrown: unknown;
    try {
      await ingestPages(workspace, [
        { slug: "people/alice", content: validPage("Alice likes hiking.") },
        {
          slug: "projects/garden",
          content: validPage("Garden redesign notes."),
        },
      ]);
    } catch (err) {
      thrown = err;
    }

    // The write error propagates to the caller.
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain(
      "simulated write failure: projects/garden",
    );
    // The first page committed before the failure and still gets its
    // reindex fan-out, once per job type.
    expect(await listPages(workspace)).toEqual(["people/alice"]);
    expect(enqueuedJobs.map((j) => j.type).sort()).toEqual([
      "memory_v2_reembed",
      "memory_v3_maintain",
    ]);
    // The lock is released despite the failure.
    expect(existsSync(lockPath())).toBe(false);
  });
});
