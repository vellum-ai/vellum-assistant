import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";

// Track calls to indexPkbFile so we can assert the handler forwards payload
// fields correctly.
const indexPkbFileCalls: Array<{
  pkbRoot: string;
  absPath: string;
}> = [];

mock.module("../pkb/pkb-index.js", () => ({
  indexPkbFile: async (pkbRoot: string, absPath: string) => {
    indexPkbFileCalls.push({ pkbRoot, absPath });
  },
}));

// Controls the enqueue gate: PKB index jobs are v1-only, so the enqueue
// helper consults memory.v2.enabled.
let v2Enabled = false;

mock.module("../config.js", () => ({
  getMemoryConfig: () => ({ v2: { enabled: v2Enabled } }),
}));

import { DEFAULT_CONFIG } from "../../../../config/defaults.js";
import type { AssistantConfig } from "../../../../config/types.js";
import { getMemoryDb } from "../../../../persistence/db-connection.js";
import { initializeDb } from "../../../../persistence/db-init.js";
import {
  claimMemoryJobs,
  type MemoryJob,
  type MemoryJobType,
} from "../../../../persistence/jobs-store.js";
import { memoryJobs } from "../../../../persistence/schema/index.js";
import { embedPkbFileJob, enqueuePkbIndexJob } from "./embed-pkb-file.js";

const TEST_CONFIG: AssistantConfig = DEFAULT_CONFIG;

function makeJob(payload: Record<string, unknown>): MemoryJob {
  return {
    id: "job-1",
    type: "embed_pkb_file",
    payload,
    status: "running",
    attempts: 0,
    deferrals: 0,
    runAfter: 0,
    lastError: null,
    startedAt: Date.now(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

describe("embedPkbFileJob", () => {
  beforeAll(async () => {
    await initializeDb();
  });

  beforeEach(() => {
    indexPkbFileCalls.length = 0;
    const db = getMemoryDb()!;
    db.delete(memoryJobs).run();
  });

  test("calls indexPkbFile with payload fields", async () => {
    await embedPkbFileJob(
      makeJob({
        pkbRoot: "/pkb/root",
        absPath: "/pkb/root/note.md",
      }),
      TEST_CONFIG,
    );

    expect(indexPkbFileCalls).toHaveLength(1);
    expect(indexPkbFileCalls[0]).toEqual({
      pkbRoot: "/pkb/root",
      absPath: "/pkb/root/note.md",
    });
  });

  test("skips when pkbRoot is missing", async () => {
    await embedPkbFileJob(
      makeJob({ absPath: "/pkb/root/note.md" }),
      TEST_CONFIG,
    );
    expect(indexPkbFileCalls).toHaveLength(0);
  });

  test("skips when absPath is missing", async () => {
    await embedPkbFileJob(makeJob({ pkbRoot: "/pkb/root" }), TEST_CONFIG);
    expect(indexPkbFileCalls).toHaveLength(0);
  });

  test("processes a legacy payload that still carries a memoryScopeId key", async () => {
    // Rows enqueued before scope removal persist in the job queue with the
    // extra key; the handler reads only pkbRoot/absPath and must not skip.
    await embedPkbFileJob(
      makeJob({
        pkbRoot: "/pkb/root",
        absPath: "/pkb/root/note.md",
        memoryScopeId: "legacy-scope",
      }),
      TEST_CONFIG,
    );

    expect(indexPkbFileCalls).toHaveLength(1);
    expect(indexPkbFileCalls[0]).toEqual({
      pkbRoot: "/pkb/root",
      absPath: "/pkb/root/note.md",
    });
  });
});

describe("enqueuePkbIndexJob", () => {
  beforeAll(async () => {
    await initializeDb();
  });

  beforeEach(() => {
    indexPkbFileCalls.length = 0;
    v2Enabled = false;
    const db = getMemoryDb()!;
    db.delete(memoryJobs).run();
  });

  test("does not enqueue when memory v2 is enabled", () => {
    v2Enabled = true;

    const id = enqueuePkbIndexJob({
      pkbRoot: "/pkb/root",
      absPath: "/pkb/root/note.md",
    });

    expect(id).toBe("");
    expect(claimMemoryJobs({ slowLlm: 10, fast: 10, embed: 10 })).toHaveLength(
      0,
    );
  });

  test("enqueues a pending embed_pkb_file job with payload", () => {
    const id = enqueuePkbIndexJob({
      pkbRoot: "/pkb/root",
      absPath: "/pkb/root/note.md",
    });
    expect(id).toBeTruthy();

    const claimed = claimMemoryJobs({ slowLlm: 10, fast: 10, embed: 10 });
    expect(claimed).toHaveLength(1);
    const [job] = claimed;
    const expectedType: MemoryJobType = "embed_pkb_file";
    expect(job.type).toBe(expectedType);
    expect(job.payload).toEqual({
      pkbRoot: "/pkb/root",
      absPath: "/pkb/root/note.md",
    });
  });

  test("round-trip: enqueued job dispatched to handler invokes indexPkbFile", async () => {
    enqueuePkbIndexJob({
      pkbRoot: "/pkb/root",
      absPath: "/pkb/root/note.md",
    });

    const claimed = claimMemoryJobs({ slowLlm: 10, fast: 10, embed: 10 });
    expect(claimed).toHaveLength(1);
    const [job] = claimed;
    expect(job.type).toBe("embed_pkb_file");

    await embedPkbFileJob(job, TEST_CONFIG);
    expect(indexPkbFileCalls).toHaveLength(1);
    expect(indexPkbFileCalls[0]).toEqual({
      pkbRoot: "/pkb/root",
      absPath: "/pkb/root/note.md",
    });
  });
});
