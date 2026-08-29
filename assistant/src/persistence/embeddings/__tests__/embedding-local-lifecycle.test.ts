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
} from "../../../util/worker-ownership.js";
import { ORPHAN_STOP_TIMEOUT_MS } from "../../../util/worker-process.js";
import { EMBEDDING_SHUTDOWN_BUDGET_MS } from "../embedding-backend.js";
import { LocalEmbeddingBackend } from "../embedding-local.js";

/** Reach past `private`, which is compile-time only, so tests drive real state. */
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
  // Whether PID 1 is an assistant daemon (exec'd as PID 1) or an init process.
  const PID1_IS_INIT = false;
  const PID1_IS_DAEMON = true;

  test("a worker parented to us is ours to reclaim", () => {
    expect(
      classifyWorkerOwnership({ pid: 100, ppid: 42 }, 42, alive, PID1_IS_INIT),
    ).toBe("reclaim");
  });

  test("a worker reparented to init is an orphan", () => {
    expect(
      classifyWorkerOwnership({ pid: 100, ppid: 1 }, 42, alive, PID1_IS_INIT),
    ).toBe("orphan");
  });

  test("a worker whose owner is gone is an orphan", () => {
    expect(
      classifyWorkerOwnership(
        { pid: 100, ppid: 999 },
        42,
        () => false,
        PID1_IS_INIT,
      ),
    ).toBe("orphan");
  });

  /**
   * Where `docker-entrypoint.sh` execs the daemon, PID 1 is that daemon and a
   * worker parented to it belongs to a live sibling. A memory-worker process
   * sweeping alongside must leave it running.
   */
  test("a worker parented to a PID 1 daemon belongs to that daemon", () => {
    expect(
      classifyWorkerOwnership({ pid: 100, ppid: 1 }, 42, alive, PID1_IS_DAEMON),
    ).toBe("foreign");
  });

  test("a daemon running as PID 1 still reclaims its own workers", () => {
    // Its children match selfPid, which is checked before the PID 1 branch.
    expect(
      classifyWorkerOwnership({ pid: 100, ppid: 1 }, 1, alive, PID1_IS_DAEMON),
    ).toBe("reclaim");
  });

  /**
   * Under `docker run --init` the container is still containerized but PID 1 is
   * docker-init, so a worker reparented there was abandoned and must stay
   * reclaimable. Deployment shape alone cannot answer this; what PID 1 is can.
   */
  test("a worker reparented to an init PID 1 stays reclaimable", () => {
    expect(
      classifyWorkerOwnership({ pid: 100, ppid: 1 }, 42, alive, PID1_IS_INIT),
    ).toBe("orphan");
  });

  /**
   * The daemon and the memory-worker process each legitimately own one worker
   * for the same workspace. Before the fix both sides matched purely on the
   * worker script path, so each killed the other's healthy worker on every
   * spawn, which is the ping-pong in the incident timeline.
   */
  test("a worker owned by another live process is left alone", () => {
    expect(
      classifyWorkerOwnership({ pid: 100, ppid: 999 }, 42, alive, PID1_IS_INIT),
    ).toBe("foreign");
  });
});

describe("worker process enumeration", () => {
  test("finds a live worker by script path and reports its owner", async () => {
    const dir = mkdtempSync(join(tmpdir(), "embed-worker-enum-"));
    const scriptPath = join(dir, "embed-worker.mjs");
    writeFileSync(scriptPath, "setTimeout(() => {}, 60_000);\n");

    const proc = Bun.spawn({
      cmd: [process.execPath, scriptPath, "test-model", "cache-dir"],
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
    expect(
      classifyWorkerOwnership(match!, process.pid, () => true, false),
    ).toBe("reclaim");
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
   * published, which is how a live worker became invisible to every later
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
   * The stdout stream ending does not prove the child exited: a read error
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

  /**
   * A worker wedged in native ONNX code can ignore SIGTERM. An unbounded wait
   * would hang every in-flight embed and block re-initialization forever, since
   * pending requests are only settled after the wait.
   */
  test("a worker that ignores SIGTERM is escalated to SIGKILL, not waited on forever", async () => {
    const backend = new LocalEmbeddingBackend("test-model") as Internals;
    backend.terminateGraceMs = 50;
    const signals: (string | undefined)[] = [];
    const wedged = {
      pid: 4321,
      // Never settles: the child is not going away on its own.
      exited: new Promise<number>(() => {}),
      kill(signal?: string) {
        signals.push(signal);
      },
    };

    const confirmed = await backend.terminateWorker(wedged);

    expect(signals).toEqual([undefined, "SIGKILL"]);
    // A successful kill() proves signal delivery, not exit.
    expect(confirmed).toBe(false);
  });
});

/**
 * The tail case: the child never exits, even after SIGKILL (uninterruptible
 * I/O). Bounding the wait must not become "assume it worked". Forgetting the
 * child here and spawning a replacement would recreate the exact
 * invisible-duplicate failure this change exists to remove, so every path
 * fails closed: ownership and the PID publication are retained, and no
 * replacement may start until the process is confirmed gone.
 */
describe("termination that cannot be confirmed", () => {
  function wedgedProc(pid = 4444) {
    return {
      pid,
      exited: new Promise<number>(() => {}),
      kill() {},
      stdin: { write() {}, flush() {} },
    };
  }

  test("keeps the PID publication instead of unpublishing a possibly-live child", async () => {
    const backend = new LocalEmbeddingBackend("test-model") as Internals;
    backend.terminateGraceMs = 20;
    const proc = wedgedProc();
    backend.workerProc = proc;
    writeFileSync(getEmbedWorkerPidPath(), String(proc.pid));

    await backend.shutdown();

    expect(existsSync(getEmbedWorkerPidPath())).toBe(true);
    expect(readFileSync(getEmbedWorkerPidPath(), "utf-8").trim()).toBe(
      String(proc.pid),
    );
    expect(backend.unconfirmedWorker).toBe(proc.pid);
  });

  test("refuses to start a replacement while the child may still be alive", async () => {
    const backend = new LocalEmbeddingBackend("test-model") as Internals;
    // No workerPath recorded, so liveness falls back to a PID probe. Our own
    // PID is certainly alive, standing in for a child that will not die.
    backend.unconfirmedWorker = process.pid;

    await expect(backend.ensureInitialized()).rejects.toThrow(
      /could not be confirmed terminated/,
    );
  });

  test("surfaces the incomplete teardown through embed() rather than failing silently", async () => {
    const backend = new LocalEmbeddingBackend("test-model") as Internals;
    backend.unconfirmedWorker = process.pid;

    await expect(backend.embed(["hello"])).rejects.toThrow(
      /could not be confirmed terminated/,
    );
  });

  test("lifts the block once the process is actually gone", async () => {
    const dir = mkdtempSync(join(tmpdir(), "embed-worker-recover-"));
    const scriptPath = join(dir, "embed-worker.mjs");
    writeFileSync(scriptPath, "setTimeout(() => {}, 60_000);\n");

    const proc = Bun.spawn({
      cmd: [process.execPath, scriptPath, "test-model", "cache-dir"],
      stdout: "ignore",
      stderr: "ignore",
    });
    await Bun.sleep(400);

    const backend = new LocalEmbeddingBackend("test-model") as Internals;
    backend.workerPath = scriptPath;
    backend.unconfirmedWorker = proc.pid;
    writeFileSync(getEmbedWorkerPidPath(), String(proc.pid));

    // Still listed, so the block holds.
    expect(backend.unconfirmedWorkerStillAlive()).toBe(true);

    proc.kill();
    await proc.exited;
    await Bun.sleep(300);

    // Gone, so the backend recovers on its own without a restart.
    expect(backend.unconfirmedWorkerStillAlive()).toBe(false);
    expect(backend.unconfirmedWorker).toBeNull();
    expect(existsSync(getEmbedWorkerPidPath())).toBe(false);
  });
});

describe("reclaiming before spawning a replacement", () => {
  /**
   * Reclaim must confirm the old worker is gone before the caller spawns its
   * replacement. Signalling and returning immediately leaves two same-owner
   * workers briefly alive and unpublishes a child not yet confirmed dead.
   */
  test("terminates a worker parented to us and waits for it to disappear", async () => {
    const dir = mkdtempSync(join(tmpdir(), "embed-worker-reclaim-"));
    const scriptPath = join(dir, "embed-worker.mjs");
    writeFileSync(scriptPath, "setTimeout(() => {}, 60_000);\n");

    const proc = Bun.spawn({
      cmd: [process.execPath, scriptPath, "test-model", "cache-dir"],
      stdout: "ignore",
      stderr: "ignore",
    });
    spawned.push(proc);
    await Bun.sleep(400);
    writeFileSync(getEmbedWorkerPidPath(), String(proc.pid));

    const backend = new LocalEmbeddingBackend("test-model") as Internals;
    await backend.reclaimOwnedWorkers(scriptPath);

    // Confirmed gone by the time reclaim returns, not merely signalled.
    expect(listWorkerProcesses(scriptPath)).toEqual([]);
    expect(existsSync(getEmbedWorkerPidPath())).toBe(false);
  });

  test("escalates to SIGKILL for a worker that ignores SIGTERM", async () => {
    const dir = mkdtempSync(join(tmpdir(), "embed-worker-stubborn-"));
    const scriptPath = join(dir, "embed-worker.mjs");
    writeFileSync(
      scriptPath,
      "process.on('SIGTERM', () => {});\nsetTimeout(() => {}, 60_000);\n",
    );

    const proc = Bun.spawn({
      cmd: [process.execPath, scriptPath, "test-model", "cache-dir"],
      stdout: "ignore",
      stderr: "ignore",
    });
    spawned.push(proc);
    await Bun.sleep(400);

    const backend = new LocalEmbeddingBackend("test-model") as Internals;
    backend.terminateGraceMs = 300;
    await backend.reclaimOwnedWorkers(scriptPath);

    expect(listWorkerProcesses(scriptPath)).toEqual([]);
  });

  test("leaves a worker owned by another live process running", async () => {
    const dir = mkdtempSync(join(tmpdir(), "embed-worker-foreign-"));
    const scriptPath = join(dir, "embed-worker.mjs");
    writeFileSync(scriptPath, "setTimeout(() => {}, 60_000);\n");

    // Spawn via an intermediate process so the worker's parent is neither us
    // nor init, standing in for the memory-worker process owning its own.
    const launcher = join(dir, "launcher.mjs");
    writeFileSync(
      launcher,
      `import { spawn } from "node:child_process";
spawn(process.execPath, [${JSON.stringify(scriptPath)}, "test-model", "cache-dir"], { stdio: "ignore" });
setTimeout(() => {}, 60_000);\n`,
    );
    const parent = Bun.spawn({
      cmd: [process.execPath, launcher],
      stdout: "ignore",
      stderr: "ignore",
    });
    spawned.push(parent);
    await Bun.sleep(600);

    const workers = listWorkerProcesses(scriptPath);
    expect(workers.length).toBe(1);
    expect(workers[0].ppid).toBe(parent.pid);

    const backend = new LocalEmbeddingBackend("test-model") as Internals;
    backend.terminateGraceMs = 300;
    await backend.reclaimOwnedWorkers(scriptPath);

    // Still alive: this is the daemon-vs-memory-worker case that used to
    // ping-pong, with each side killing the other's healthy worker.
    expect(listWorkerProcesses(scriptPath).map((w) => w.pid)).toEqual([
      workers[0].pid,
    ]);
    try {
      process.kill(workers[0].pid, "SIGKILL");
    } catch {
      /* cleanup */
    }
  });
});

describe("shutdown versus in-flight initialization", () => {
  /**
   * Shutting down while `initialize()` is still running (downloading the
   * runtime, loading the model) sees `workerProc === null`. Returning there
   * lets the initializer spawn a worker afterwards, with nobody left to reap it.
   */
  test("shutdown waits for an in-flight init and reaps the worker it creates", async () => {
    const backend = new LocalEmbeddingBackend("test-model") as Internals;
    const proc = liveProc(600);

    let finishInit: () => void = () => {};
    backend.initialize = () =>
      new Promise<void>((resolve) => {
        finishInit = () => {
          backend.workerProc = proc;
          resolve();
        };
      });

    const initDone = backend.ensureInitialized();
    const shutdownDone = backend.shutdown();

    let shutdownSettled = false;
    void shutdownDone.then(() => {
      shutdownSettled = true;
    });
    await Bun.sleep(50);
    expect(shutdownSettled).toBe(false);

    finishInit();
    await initDone;
    await shutdownDone;

    expect(proc.killed).toBe(true);
    expect(backend.workerProc).toBeNull();
  });
});

/**
 * Two parent-exit orderings that could still strand a child.
 */
describe("parent exit orderings", () => {
  /**
   * A process being evicted cannot wait: staying alive to reap would let it
   * keep running a job its successor has already reclaimed. But it also cannot
   * defer to the successor's sweep, because eviction is noticed on a 15s poll,
   * long after that single sweep classified the child as another live
   * process's and left it alone. So it kills its own child on the way out.
   */
  test("terminateNow kills the worker and releases the entry without waiting", () => {
    const backend = new LocalEmbeddingBackend("test-model") as Internals;
    const signals: string[] = [];
    const proc = {
      pid: 909,
      exited: new Promise<number>(() => {}),
      kill(signal?: string) {
        signals.push(signal ?? "SIGTERM");
      },
      stdin: { write() {}, flush() {} },
    };
    backend.workerProc = proc;
    writeFileSync(getEmbedWorkerPidPath(), "909");

    backend.terminateNow();

    expect(signals).toEqual(["SIGKILL"]);
    expect(backend.workerProc).toBeNull();
    expect(existsSync(getEmbedWorkerPidPath())).toBe(false);
  });

  /**
   * `waitForReady` allows two minutes for a cold model load. Shutdown must not
   * inherit that: the caller's own deadline would fire first and exit the
   * process while the child was still being adopted.
   */
  test("shutdown does not inherit the model-load wait when init never settles", async () => {
    const backend = new LocalEmbeddingBackend("test-model") as Internals;
    backend.terminateGraceMs = 50;
    // An initialization that never resolves, as during a cold model load.
    backend.initInFlight = new Promise<void>(() => {});

    const started = Date.now();
    await backend.shutdown();

    expect(Date.now() - started).toBeLessThan(2_000);
  });

  test("a backend already shutting down refuses to spawn a replacement", async () => {
    const backend = new LocalEmbeddingBackend("test-model") as Internals;
    backend.disposeRequested = true;

    await expect(backend.embed(["hello"])).rejects.toThrow(/shutting down/);
  });
});

/**
 * `embedding-backend.ts` marks the local backend permanently broken when an
 * error message contains "Local embedding backend unavailable", which is how a
 * compiled binary missing onnxruntime-node stops auto mode retrying local
 * forever. Only genuinely permanent conditions may use that wording: a
 * transient failure carrying it would disable local embeddings for the rest of
 * the process over something that resolves on its own.
 */
describe("transient failures stay transient", () => {
  const PERMANENT_FAILURE_SENTINEL = "Local embedding backend unavailable";

  test("an unconfirmed termination does not claim permanent unavailability", async () => {
    const backend = new LocalEmbeddingBackend("test-model") as Internals;
    backend.unconfirmedWorker = process.pid;

    const err = await backend.ensureInitialized().catch((e: Error) => e);

    expect(err.message).toContain("could not be confirmed terminated");
    expect(err.message).not.toContain(PERMANENT_FAILURE_SENTINEL);
  });

  test("shutting down does not claim permanent unavailability", async () => {
    const backend = new LocalEmbeddingBackend("test-model") as Internals;
    backend.disposeRequested = true;

    const err = await backend.embed(["hello"]).catch((e: Error) => e);

    expect(err.message).not.toContain(PERMANENT_FAILURE_SENTINEL);
  });
});

/**
 * Defects found by a self-audit of this change, each of which strands a worker
 * or wedges the backend permanently.
 */
describe("audit regressions", () => {
  /**
   * A worker that wedges during model load never exits on SIGTERM. The startup
   * failure path used a bare `await proc.exited`, so it hung there forever,
   * leaving the init guard holding a promise that never settles and every later
   * embed queued behind it.
   */
  test("a startup failure against a wedged worker does not hang", async () => {
    const backend = new LocalEmbeddingBackend("test-model") as Internals;
    backend.terminateGraceMs = 30;
    const signals: (string | undefined)[] = [];
    backend.workerProc = {
      pid: 7001,
      exitCode: null,
      exited: new Promise<number>(() => {}),
      kill(signal?: string) {
        signals.push(signal);
      },
      stdin: { write() {}, flush() {} },
      stderr: new ReadableStream(),
    };

    const started = Date.now();
    const confirmed = await backend.terminateWorker(backend.workerProc);

    expect(confirmed).toBe(false);
    expect(signals).toEqual([undefined, "SIGKILL"]);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  /**
   * A partial line left by a killed worker would otherwise be prepended to the
   * replacement's first line, destroying its `ready` signal and stalling
   * startup for the full two-minute timeout.
   */
  test("terminateNow clears the stdout buffer so a retry can parse ready", () => {
    const backend = new LocalEmbeddingBackend("test-model") as Internals;
    backend.stdoutBuffer = '{"id":5,"vect';
    backend.workerProc = null;

    backend.terminateNow();

    expect(backend.stdoutBuffer).toBe("");
  });

  /**
   * `terminateNow` runs immediately before `process.exit`, so anything it fails
   * to see is orphaned outright. A worker spawned but not yet adopted into
   * `workerProc` is invisible to the handle, but not to parentage.
   */
  test("terminateNow reaps a child it holds no handle for", async () => {
    const dir = mkdtempSync(join(tmpdir(), "embed-worker-nohandle-"));
    const scriptPath = join(dir, "embed-worker.mjs");
    writeFileSync(scriptPath, "setTimeout(() => {}, 60_000);\n");

    const proc = Bun.spawn({
      cmd: [process.execPath, scriptPath, "test-model", "cache-dir"],
      stdout: "ignore",
      stderr: "ignore",
    });
    spawned.push(proc);
    await Bun.sleep(400);

    const backend = new LocalEmbeddingBackend("test-model") as Internals;
    backend.workerPath = scriptPath;
    backend.workerProc = null; // spawned, never adopted

    backend.terminateNow();
    await Bun.sleep(300);

    expect(listWorkerProcesses(scriptPath)).toEqual([]);
  });

  /**
   * `terminateNow` is on the public backend interface with no exit-only
   * contract, so it must leave the instance able to start a replacement.
   */
  test("terminateNow leaves the instance reusable", () => {
    const backend = new LocalEmbeddingBackend("test-model") as Internals;
    backend.workerProc = null;
    backend.stdoutReaderActive = true;

    backend.terminateNow();

    expect(backend.stdoutReaderActive).toBe(false);
    expect(backend.initGuard.active).toBe(false);
  });
});

describe("model matching", () => {
  test("a worker for a longer model name is not matched by a shorter one", async () => {
    const dir = mkdtempSync(join(tmpdir(), "embed-worker-model-"));
    const scriptPath = join(dir, "embed-worker.mjs");
    writeFileSync(scriptPath, "setTimeout(() => {}, 60_000);\n");

    const proc = Bun.spawn({
      cmd: [process.execPath, scriptPath, "foo/bar-small-v2", "cache-dir"],
      stdout: "ignore",
      stderr: "ignore",
    });
    spawned.push(proc);
    await Bun.sleep(400);

    // The worker script path is shared by every local model, so only the model
    // argv token separates one backend's worker from another's in one process.
    expect(listWorkerProcesses(scriptPath, "foo/bar-small")).toEqual([]);
    expect(
      listWorkerProcesses(scriptPath, "foo/bar-small-v2").map((w) => w.pid),
    ).toEqual([proc.pid]);
  });
});

// The daemon's orphan reclaim SIGTERMs a stale memory worker and waits
// ORPHAN_STOP_TIMEOUT_MS before SIGKILL. That worker's shutdown reaps the ONNX
// subprocess it owns, bounded at EMBEDDING_SHUTDOWN_BUDGET_MS + 1s. If the
// reclaim ceiling does not outlast the reap, reclaiming kills the worker
// mid-reap and strands the subprocess, which is the JARVIS-1125 failure.
test("orphan reclaim outlasts the embedding reap it must not truncate", () => {
  expect(ORPHAN_STOP_TIMEOUT_MS).toBeGreaterThan(
    EMBEDDING_SHUTDOWN_BUDGET_MS + 1_000,
  );
});
