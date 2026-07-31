/**
 * Worker-lifecycle invariants for the local embedding backend (JARVIS-1125).
 *
 * The contract under test:
 *   1. At most one live worker per workspace AND owning process.
 *   2. No path forgets or unpublishes a worker before confirming it exited.
 *   3. A dead worker pipe is a recoverable embed failure, never an escaping
 *      rejection that would take the daemon down.
 *   4. Shutdown reaps process-owned workers deterministically.
 */

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import { getEmbedWorkerPidPath } from "../../../util/platform.js";
import {
  classifyWorkerOwnership,
  listWorkerProcesses,
  LocalEmbeddingBackend,
} from "../embedding-local.js";

/** Reach past `private` — compile-time only, so tests can drive real state. */
type Internals = any;

/**
 * A stand-in for a Bun subprocess whose stdin pipe is broken. `write` throws
 * EPIPE the way a real worker's pipe does once the child is gone.
 */
function brokenPipeProc(pid = 4242) {
  return {
    pid,
    killed: false,
    exited: Promise.resolve(0),
    kill() {
      this.killed = true;
    },
    stdin: {
      write() {
        throw Object.assign(new Error("EPIPE: broken pipe, write"), {
          code: "EPIPE",
        });
      },
      flush() {},
    },
  };
}

/** A subprocess that stays "alive" until killed, so exit can be observed. */
function liveProc(pid = 4243) {
  let resolveExit: (code: number) => void = () => {};
  const exited = new Promise<number>((r) => {
    resolveExit = r;
  });
  return {
    pid,
    killed: false,
    exited,
    kill() {
      this.killed = true;
      resolveExit(0);
    },
    stdin: { write() {}, flush() {} },
  };
}

const spawned: { kill(): void }[] = [];

afterEach(() => {
  for (const proc of spawned.splice(0)) {
    try {
      proc.kill();
    } catch {
      /* already gone */
    }
  }
});

describe("worker ownership classification", () => {
  const alive = () => true;

  test("a worker parented to us is ours to reclaim", () => {
    expect(classifyWorkerOwnership({ pid: 100, ppid: 42 }, 42, alive)).toBe(
      "reclaim",
    );
  });

  test("a worker reparented to init is an orphan", () => {
    expect(classifyWorkerOwnership({ pid: 100, ppid: 1 }, 42, alive)).toBe(
      "orphan",
    );
  });

  test("a worker whose owner is gone is an orphan", () => {
    expect(
      classifyWorkerOwnership({ pid: 100, ppid: 999 }, 42, () => false),
    ).toBe("orphan");
  });

  /**
   * The daemon and the memory-worker process each legitimately own one worker
   * for the same workspace. Before the fix both sides matched purely on the
   * worker script path, so each killed the other's healthy worker on every
   * spawn — the ping-pong in the incident timeline.
   */
  test("a worker owned by another live process is left alone", () => {
    expect(classifyWorkerOwnership({ pid: 100, ppid: 999 }, 42, alive)).toBe(
      "foreign",
    );
  });
});

describe("worker process enumeration", () => {
  test("finds a live worker by script path and reports its owner", async () => {
    const dir = mkdtempSync(join(tmpdir(), "embed-worker-enum-"));
    const scriptPath = join(dir, "embed-worker.mjs");
    writeFileSync(scriptPath, "setTimeout(() => {}, 60_000);\n");

    const proc = Bun.spawn({
      cmd: [process.execPath, scriptPath],
      stdout: "ignore",
      stderr: "ignore",
    });
    spawned.push(proc);
    // Give the OS a moment to publish the new process in the table.
    await Bun.sleep(400);

    const found = listWorkerProcesses(scriptPath);
    const match = found.find((w) => w.pid === proc.pid);
    expect(match).toBeDefined();
    expect(match?.ppid).toBe(process.pid);

    // Ownership of a child of ours must resolve to "reclaim", which is what
    // lets a spawn reap a worker the instance had lost track of.
    expect(classifyWorkerOwnership(match!, process.pid, () => true)).toBe(
      "reclaim",
    );
  });

  test("does not match another workspace's worker path", () => {
    const found = listWorkerProcesses(
      join(tmpdir(), "definitely-not-a-real-workspace", "embed-worker.mjs"),
    );
    expect(found).toEqual([]);
  });
});

describe("PID file ownership", () => {
  const pidPath = getEmbedWorkerPidPath();

  /**
   * The PID file is one workspace-scoped slot shared by every backend instance.
   * An unconditional unlink on teardown deletes whichever worker is currently
   * published — which is how a live worker became invisible to every later
   * reclaim and survived until reboot.
   */
  test("releasePidFile leaves an entry that names someone else's worker", () => {
    writeFileSync(pidPath, "777");
    const backend = new LocalEmbeddingBackend("test-model") as Internals;

    backend.releasePidFile(888);

    expect(existsSync(pidPath)).toBe(true);
    expect(readFileSync(pidPath, "utf-8").trim()).toBe("777");
  });

  test("releasePidFile drops the entry when it names our worker", () => {
    writeFileSync(pidPath, "777");
    const backend = new LocalEmbeddingBackend("test-model") as Internals;

    backend.releasePidFile(777);

    expect(existsSync(pidPath)).toBe(false);
  });

  /**
   * An instance whose worker already exited owns nothing, so its disposal must
   * not unpublish the worker another instance has since registered.
   */
  test("disposing an instance with no worker keeps another's PID entry", () => {
    writeFileSync(pidPath, "777");
    const backend = new LocalEmbeddingBackend("test-model") as Internals;
    backend.disposeRequested = true;
    backend.workerProc = null;

    backend.disposeIfIdle();

    expect(existsSync(pidPath)).toBe(true);
    expect(readFileSync(pidPath, "utf-8").trim()).toBe("777");
  });
});

describe("broken worker pipe", () => {
  /**
   * A write to a dead worker raises EPIPE. Escaping, it reached the daemon's
   * `unhandledRejection` handler and terminated the process; it must instead
   * come back as an ordinary failed embed the backend chain can fall back from.
   */
  test("EPIPE on write resolves the request as an error", async () => {
    const backend = new LocalEmbeddingBackend("test-model") as Internals;
    backend.workerProc = brokenPipeProc();

    const response = await backend.sendRequest(["hello"]);

    expect(response.error).toContain("worker pipe write failed");
    expect(response.vectors).toBeUndefined();
  });

  test("EPIPE surfaces to embed() as a rejection, not a process crash", async () => {
    const backend = new LocalEmbeddingBackend("test-model") as Internals;
    backend.workerProc = brokenPipeProc();
    // Skip initialization: the worker is already (notionally) running.
    backend.ensureInitialized = async () => {};

    await expect(backend.embed(["hello"])).rejects.toThrow(
      /worker pipe write failed/,
    );
  });

  test("a failed write does not leak the pending request", async () => {
    const backend = new LocalEmbeddingBackend("test-model") as Internals;
    backend.workerProc = brokenPipeProc();

    await backend.sendRequest(["hello"]);

    expect(backend.pendingRequests.size).toBe(0);
  });
});

describe("releasing ownership of a worker", () => {
  /**
   * The stdout stream ending does not prove the child exited — a read error
   * ends the reader loop just the same. Forgetting a still-running child
   * strands it: no handle, no PID entry, invisible to every later reclaim.
   */
  test("stdout ending kills the child before clearing workerProc", async () => {
    const backend = new LocalEmbeddingBackend("test-model") as Internals;
    const proc = liveProc();
    backend.workerProc = proc;

    await backend.terminateWorker(proc);

    expect(proc.killed).toBe(true);
    await expect(proc.exited).resolves.toBe(0);
  });

  test("shutdown reaps the worker and resolves only once it exits", async () => {
    const backend = new LocalEmbeddingBackend("test-model") as Internals;
    const proc = liveProc(555);
    backend.workerProc = proc;
    writeFileSync(getEmbedWorkerPidPath(), "555");

    await backend.shutdown();

    expect(proc.killed).toBe(true);
    expect(backend.workerProc).toBeNull();
    expect(existsSync(getEmbedWorkerPidPath())).toBe(false);
  });

  test("shutdown settles in-flight requests instead of hanging them", async () => {
    const backend = new LocalEmbeddingBackend("test-model") as Internals;
    backend.workerProc = liveProc(556);

    const inFlight = backend.sendRequest(["hello"]);
    await backend.shutdown();

    await expect(inFlight).resolves.toMatchObject({
      error: expect.stringContaining("shutting down"),
    });
  });
});
