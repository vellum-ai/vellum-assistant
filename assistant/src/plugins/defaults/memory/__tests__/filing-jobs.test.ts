/**
 * Tests for the `pkb_filing` / `pkb_compaction` job handlers.
 *
 * Both handlers run as the assistant via `runBackgroundJob` (mocked here):
 * the tests pin the call-site attribution, prompt selection, and the filing
 * handler's empty-buffer skip (bypassed by a `{ force: true }` payload, which
 * is how the `filing/run-now` route enqueues).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

import { createMockLoggerModule } from "../../../../__tests__/helpers/mock-logger.js";

mock.module("../../../../util/logger.js", () => createMockLoggerModule());

const runBackgroundJobMock = mock(
  async (_opts: Record<string, unknown>) =>
    ({ ok: true, conversationId: "conv-filing-test" }) as const,
);
mock.module("../../../../runtime/background-job-runner.js", () => ({
  runBackgroundJob: (opts: Record<string, unknown>) =>
    runBackgroundJobMock(opts),
}));

// Workspace pin must precede the handler import — `hasPkbBufferContent`
// resolves the buffer path from the workspace dir.
let tmpWorkspace: string;
let previousWorkspaceEnv: string | undefined;

beforeAll(() => {
  tmpWorkspace = mkdtempSync(join(tmpdir(), "filing-jobs-test-"));
  previousWorkspaceEnv = process.env.VELLUM_WORKSPACE_DIR;
  process.env.VELLUM_WORKSPACE_DIR = tmpWorkspace;
});

afterAll(() => {
  if (previousWorkspaceEnv === undefined) {
    delete process.env.VELLUM_WORKSPACE_DIR;
  } else {
    process.env.VELLUM_WORKSPACE_DIR = previousWorkspaceEnv;
  }
  rmSync(tmpWorkspace, { recursive: true, force: true });
});

const { pkbCompactionJob, pkbFilingJob } = await import("../filing-jobs.js");

import type { MemoryJob } from "../../../../persistence/jobs-store.js";

function makeJob(payload: Record<string, unknown> = {}): MemoryJob {
  return {
    id: "job-1",
    type: "pkb_filing",
    payload,
  } as unknown as MemoryJob;
}

function writePkbBuffer(content: string): void {
  const pkbDir = join(tmpWorkspace, "pkb");
  mkdirSync(pkbDir, { recursive: true });
  writeFileSync(join(pkbDir, "buffer.md"), content);
}

function removePkbBuffer(): void {
  rmSync(join(tmpWorkspace, "pkb", "buffer.md"), { force: true });
}

beforeEach(() => {
  runBackgroundJobMock.mockClear();
  removePkbBuffer();
});

describe("pkbFilingJob", () => {
  test("skips without an LLM run when the buffer is empty", async () => {
    await pkbFilingJob(makeJob());

    expect(runBackgroundJobMock).not.toHaveBeenCalled();
  });

  test("runs the filing prompt as the filingAgent call site when the buffer has content", async () => {
    writePkbBuffer("- a filable fact\n");

    await pkbFilingJob(makeJob());

    expect(runBackgroundJobMock).toHaveBeenCalledTimes(1);
    const opts = runBackgroundJobMock.mock.calls[0]![0]!;
    expect(opts.jobName).toBe("filing");
    expect(opts.source).toBe("filing");
    expect(opts.callSite).toBe("filingAgent");
    expect(String(opts.prompt)).toContain("periodic knowledge base filing job");
    expect(opts.trustContext).toEqual({
      sourceChannel: "vellum",
      trustClass: "guardian",
    });
  });

  test("force payload bypasses the empty-buffer skip", async () => {
    await pkbFilingJob(makeJob({ force: true }));

    expect(runBackgroundJobMock).toHaveBeenCalledTimes(1);
  });
});

describe("pkbCompactionJob", () => {
  test("runs the compaction prompt as the compactionAgent call site", async () => {
    await pkbCompactionJob();

    expect(runBackgroundJobMock).toHaveBeenCalledTimes(1);
    const opts = runBackgroundJobMock.mock.calls[0]![0]!;
    expect(opts.jobName).toBe("compaction");
    expect(opts.callSite).toBe("compactionAgent");
    expect(String(opts.prompt)).toContain("daily PKB compaction job");
  });
});
