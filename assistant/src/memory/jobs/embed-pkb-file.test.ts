import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

// Track calls to indexPkbFile so we can assert the handler forwards payload
// fields correctly.
const indexPkbFileCalls: Array<{
  pkbRoot: string;
  absPath: string;
  memoryScopeId: string;
}> = [];

mock.module("../pkb/pkb-index.js", () => ({
  indexPkbFile: async (
    pkbRoot: string,
    absPath: string,
    memoryScopeId: string,
  ) => {
    indexPkbFileCalls.push({ pkbRoot, absPath, memoryScopeId });
  },
}));

mock.module("../../config/loader.js", () => ({
  loadConfig: () => ({}),
  getConfig: () => ({}),
  invalidateConfigCache: () => {},
}));

import { DEFAULT_CONFIG } from "../../config/defaults.js";
import type { AssistantConfig } from "../../config/types.js";
import { getDb, initializeDb } from "../db.js";
import {
  claimMemoryJobs,
  type MemoryJob,
  type MemoryJobType,
} from "../jobs-store.js";
import { memoryJobs } from "../schema.js";
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
  beforeAll(() => {
    initializeDb();
  });

  beforeEach(() => {
    indexPkbFileCalls.length = 0;
    const db = getDb();
    db.delete(memoryJobs).run();
  });

  test("calls indexPkbFile with payload fields", async () => {
    await embedPkbFileJob(
      makeJob({
        pkbRoot: "/pkb/root",
        absPath: "/pkb/root/note.md",
        memoryScopeId: "scope-123",
      }),
      TEST_CONFIG,
    );

    expect(indexPkbFileCalls).toHaveLength(1);
    expect(indexPkbFileCalls[0]).toEqual({
      pkbRoot: "/pkb/root",
      absPath: "/pkb/root/note.md",
      memoryScopeId: "scope-123",
    });
  });

  test("skips when pkbRoot is missing", async () => {
    await embedPkbFileJob(
      makeJob({ absPath: "/pkb/root/note.md", memoryScopeId: "scope-123" }),
      TEST_CONFIG,
    );
    expect(indexPkbFileCalls).toHaveLength(0);
  });

  test("skips when absPath is missing", async () => {
    await embedPkbFileJob(
      makeJob({ pkbRoot: "/pkb/root", memoryScopeId: "scope-123" }),
      TEST_CONFIG,
    );
    expect(indexPkbFileCalls).toHaveLength(0);
  });

  test("skips when memoryScopeId is missing", async () => {
    await embedPkbFileJob(
      makeJob({ pkbRoot: "/pkb/root", absPath: "/pkb/root/note.md" }),
      TEST_CONFIG,
    );
    expect(indexPkbFileCalls).toHaveLength(0);
  });
});

describe("enqueuePkbIndexJob", () => {
  beforeAll(() => {
    initializeDb();
  });

  beforeEach(() => {
    indexPkbFileCalls.length = 0;
    const db = getDb();
    db.delete(memoryJobs).run();
  });

  test("enqueues a pending embed_pkb_file job with payload", () => {
    const id = enqueuePkbIndexJob({
      pkbRoot: "/pkb/root",
      absPath: "/pkb/root/note.md",
      memoryScopeId: "scope-abc",
    });
    expect(id).toBeTruthy();

    const claimed = claimMemoryJobs(10);
    expect(claimed).toHaveLength(1);
    const [job] = claimed;
    const expectedType: MemoryJobType = "embed_pkb_file";
    expect(job.type).toBe(expectedType);
    expect(job.payload).toEqual({
      pkbRoot: "/pkb/root",
      absPath: "/pkb/root/note.md",
      memoryScopeId: "scope-abc",
    });
  });

  test("round-trip: enqueued job dispatched to handler invokes indexPkbFile", async () => {
    enqueuePkbIndexJob({
      pkbRoot: "/pkb/root",
      absPath: "/pkb/root/note.md",
      memoryScopeId: "scope-rt",
    });

    const claimed = claimMemoryJobs(10);
    expect(claimed).toHaveLength(1);
    const [job] = claimed;
    expect(job.type).toBe("embed_pkb_file");

    await embedPkbFileJob(job, TEST_CONFIG);
    expect(indexPkbFileCalls).toHaveLength(1);
    expect(indexPkbFileCalls[0]).toEqual({
      pkbRoot: "/pkb/root",
      absPath: "/pkb/root/note.md",
      memoryScopeId: "scope-rt",
    });
  });
});
