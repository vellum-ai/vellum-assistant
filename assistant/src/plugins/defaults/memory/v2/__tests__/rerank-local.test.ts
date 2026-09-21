import { afterEach, expect, test } from "bun:test";

import { LocalRerankBackend } from "../rerank-local.js";

/** Reach past `private`, which is compile-time only, so tests drive real state. */
type Internals = any;

const spawned: { kill(signal?: NodeJS.Signals): void }[] = [];

afterEach(() => {
  for (const proc of spawned.splice(0)) {
    try {
      proc.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
});

/**
 * A real pipe, because the failure lives in Bun's behaviour: a payload larger
 * than the pipe buffer, sent to a worker too busy to drain stdin, leaves the
 * write pending, and the pending write rejects when the worker dies. Left
 * unobserved, that rejection reaches the daemon's `unhandledRejection` handler,
 * which shuts the process down.
 */
test("a write still pending when the worker dies resolves the request as an error", async () => {
  const backend = new LocalRerankBackend("test-model", "q8") as Internals;
  const proc = Bun.spawn({
    cmd: [process.execPath, "-e", "setTimeout(() => {}, 60_000)"],
    windowsHide: true,
    stdin: "pipe",
    stdout: "ignore",
    stderr: "ignore",
  });
  spawned.push(proc);
  backend.workerProc = proc;

  const request = backend.sendRequest({
    queries: ["q"],
    passages: ["x".repeat(4 * 1024 * 1024)],
  });
  proc.kill("SIGKILL");
  const response = await request;

  expect(response.error).toContain("worker pipe write failed");
  expect(backend.pendingRequests.size).toBe(0);
});
