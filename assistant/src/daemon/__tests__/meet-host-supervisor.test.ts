/**
 * Unit tests for `MeetHostSupervisor`. The tests replace
 * `child_process.spawn` and `net.connect` with in-memory stubs so the
 * supervisor can be exercised end-to-end without touching real
 * subprocesses or Unix sockets.
 *
 * Coverage:
 *   1. First `ensureRunning()` spawns; a concurrent second call shares
 *      the in-flight promise (no double-spawn).
 *   2. Session counter behaviour: `reportSessionStarted` cancels the
 *      idle timer; returning to zero sessions arms it; timer expiry
 *      triggers a graceful shutdown path.
 *   3. Hash-mismatch rejects the `ensureRunning()` promise with a
 *      clear error and leaves the supervisor ready to re-spawn on the
 *      next call.
 *   4. Crash after successful startup nulls the handle; the next
 *      `ensureRunning()` call spawns again.
 */

import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// Stub the config loader before importing the module under test so the
// idle-timeout reader doesn't walk into the real workspace loader.
mock.module("../../config/loader.js", () => ({
  getConfig: () => ({}),
  getNestedValue: () => undefined,
}));

// Stub the logger to keep test output clean.
mock.module("../../util/logger.js", () => ({
  getLogger: () => ({
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  }),
}));

// Stub the skill-socket-path helper so tests don't touch the real
// workspace directory.
mock.module("../../ipc/skill-socket-path.js", () => ({
  getSkillSocketPath: () => "/tmp/test-skill.sock",
  resolveSkillIpcSocketPath: () => ({ path: "/tmp/test-skill.sock" }),
}));

const { MeetHostSupervisor } = await import("../meet-host-supervisor.js");
const { __clearGlobalSkillIpcSenderForTesting } =
  await import("../meet-host-supervisor.js");

// ---------------------------------------------------------------------------
// Fake child process + fake socket
// ---------------------------------------------------------------------------

class FakeChild extends EventEmitter {
  killed = false;
  exitCode: number | null = null;
  pid = 12345;
  stdout = new PassThrough();
  stderr = new PassThrough();
  /** When true, `kill()` queues the exit until `flushDeferredExit()`. */
  deferExit = false;
  private pendingExit: {
    code: number;
    signal: NodeJS.Signals | number;
  } | null = null;
  kill = mock((_signal?: NodeJS.Signals | number) => {
    if (this.exitCode != null) return true;
    this.exitCode = 143;
    this.killed = true;
    if (this.deferExit) {
      this.pendingExit = { code: 143, signal: _signal ?? "SIGTERM" };
      return true;
    }
    queueMicrotask(() => {
      this.emit("exit", 143, _signal ?? "SIGTERM");
    });
    return true;
  });

  /** Emit a deferred exit queued by `kill()` while `deferExit` was true. */
  flushDeferredExit() {
    const pending = this.pendingExit;
    if (!pending) return;
    this.pendingExit = null;
    this.emit("exit", pending.code, pending.signal);
  }

  /** Force-exit the child with a given code (simulated crash). */
  simulateExit(code: number | null, signal: NodeJS.Signals | null = null) {
    if (this.exitCode != null) return;
    this.exitCode = code ?? 0;
    this.emit("exit", code, signal);
  }
}

class FakeSocket extends EventEmitter {
  write = mock((_data: string, cb?: (err?: Error) => void) => {
    if (cb) cb();
    return true;
  });
  destroy = mock(() => {
    // Intentionally silent.
  });
  /** Simulate async "connect" event firing on the next tick. */
  triggerConnect() {
    queueMicrotask(() => this.emit("connect"));
  }
}

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

interface Harness {
  child: FakeChild;
  supervisor: InstanceType<typeof MeetHostSupervisor>;
  spawnFn: ReturnType<typeof mock>;
  connectFn: ReturnType<typeof mock>;
  sendRequest: ReturnType<typeof mock>;
}

function makeHarness(
  overrides: {
    manifestHash?: string;
    idleTimeoutMs?: number;
    gracefulExitGraceMs?: number;
    sigkillGraceMs?: number;
    sendRequestImpl?: (...args: unknown[]) => Promise<unknown>;
  } = {},
): Harness {
  const child = new FakeChild();
  const spawnFn = mock(() => child as unknown as ChildProcess);
  const connectFn = mock(() => {
    const sock = new FakeSocket();
    sock.triggerConnect();
    return sock as unknown as Socket;
  });
  const sendRequest = mock(
    overrides.sendRequestImpl ??
      (async (..._args: unknown[]) => ({ ok: true })),
  );
  const ipcSender = {
    sendRequest: sendRequest as unknown as (
      connection: unknown,
      method: string,
      params?: unknown,
      opts?: { timeoutMs?: number },
    ) => Promise<unknown>,
  };
  const supervisor = new MeetHostSupervisor({
    skillRuntimePath: "/fake/skills/meet-join",
    bunBinaryPath: "/fake/bin/bun",
    skillSocketPath: "/tmp/test-skill.sock",
    manifest: { sourceHash: overrides.manifestHash ?? "hash-abc" },
    ipcSender: ipcSender as ConstructorParameters<
      typeof MeetHostSupervisor
    >[0]["ipcSender"],
    spawnFn,
    connectFn,
    idleTimeoutMsOverride: overrides.idleTimeoutMs ?? 60_000,
    gracefulExitGraceMs: overrides.gracefulExitGraceMs ?? 5,
    sigkillGraceMs: overrides.sigkillGraceMs ?? 5,
  });
  return { child, supervisor, spawnFn, connectFn, sendRequest };
}

/** Drain pending I/O callbacks so queued handshake promises settle. */
function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MeetHostSupervisor", () => {
  let harness: Harness;

  afterEach(async () => {
    // Make sure no supervisor lingers with a live timer between tests.
    try {
      await harness?.supervisor.shutdown();
    } catch {
      // Shutdown during tests may already have been triggered.
    }
  });

  beforeEach(() => {
    // Replaced per-test via makeHarness; initialize to undefined so
    // afterEach's optional chain is safe on tests that throw early.
    harness = undefined as unknown as Harness;
  });

  test("first ensureRunning() spawns; concurrent second call shares the promise", async () => {
    harness = makeHarness();
    const { supervisor, spawnFn } = harness;

    const p1 = supervisor.ensureRunning();
    const p2 = supervisor.ensureRunning();

    // Both promises should be the same in-flight spawn — only one spawn call.
    expect(spawnFn).toHaveBeenCalledTimes(1);

    // Deliver the handshake after both callers have subscribed.
    await tick();
    supervisor.notifyHandshake({ sourceHash: "hash-abc" });

    await Promise.all([p1, p2]);
    expect(supervisor.isRunning).toBe(true);

    // A third call after the child is up must not re-spawn.
    await supervisor.ensureRunning();
    expect(spawnFn).toHaveBeenCalledTimes(1);

    // Sanity: spawn was called with our bun binary + register.ts.
    const [, args] = spawnFn.mock.calls[0] as [string, readonly string[]];
    expect(args[0]).toBe("run");
    expect(args[1]).toBe("/fake/skills/meet-join/register.ts");
    expect(args.some((a) => a.startsWith("--ipc="))).toBe(true);
    expect(args).toContain("--skill-id=meet-join");
  });

  test("setActiveConnection resolves a pending handshake (lazy-external readiness)", async () => {
    harness = makeHarness();
    const { supervisor } = harness;

    const p = supervisor.ensureRunning();
    await tick();
    // Production path: the first `host.registries.register_*` frame
    // funnels through `setActiveConnection`. That should also be the
    // readiness signal — no separate `notifyHandshake` is wired today.
    supervisor.setActiveConnection({
      connectionId: "conn-ready",
      addRouteHandle: () => undefined,
      addSkillToolsOwner: () => undefined,
    } as unknown as Parameters<typeof supervisor.setActiveConnection>[0]);

    await p;
    expect(supervisor.isRunning).toBe(true);
  });

  test("hash mismatch rejects ensureRunning with a clear error and allows re-spawn", async () => {
    harness = makeHarness({ manifestHash: "expected-hash" });
    const { supervisor, spawnFn, child: firstChild } = harness;

    const p = supervisor.ensureRunning();
    await tick();
    supervisor.notifyHandshake({ sourceHash: "wrong-hash" });

    await expect(p).rejects.toThrow(/source hash mismatch/);
    await expect(p).rejects.toThrow(/Regenerate the meet-join manifest/);

    expect(firstChild.kill).toHaveBeenCalledWith("SIGKILL");

    // After a rejected handshake the supervisor should be ready to try again.
    expect(supervisor.isRunning).toBe(false);

    const secondChild = new FakeChild();
    spawnFn.mockImplementation(() => secondChild as unknown as ChildProcess);

    const p2 = supervisor.ensureRunning();
    expect(spawnFn).toHaveBeenCalledTimes(2);
    await tick();
    supervisor.notifyHandshake({ sourceHash: "expected-hash" });
    await p2;
    expect(supervisor.isRunning).toBe(true);
  });

  test("stale exit handler from a replaced child does not kill the successor", async () => {
    harness = makeHarness({ manifestHash: "expected-hash" });
    const { supervisor, spawnFn, child: firstChild } = harness;
    // Defer the first child's exit so it fires AFTER the respawn —
    // mirrors real Node.js, where SIGCHLD arrives on a later tick.
    firstChild.deferExit = true;

    const p = supervisor.ensureRunning();
    await tick();
    supervisor.notifyHandshake({ sourceHash: "wrong-hash" });
    await expect(p).rejects.toThrow(/source hash mismatch/);
    expect(firstChild.kill).toHaveBeenCalledWith("SIGKILL");

    // Respawn before the old child's exit event fires.
    const secondChild = new FakeChild();
    spawnFn.mockImplementation(() => secondChild as unknown as ChildProcess);
    const p2 = supervisor.ensureRunning();
    await tick();
    supervisor.notifyHandshake({ sourceHash: "expected-hash" });
    await p2;
    expect(supervisor.isRunning).toBe(true);

    // Now deliver the stale exit. Without the guard this rejects the
    // (already-resolved) handshake and SIGKILL's secondChild.
    firstChild.flushDeferredExit();
    await tick();

    expect(secondChild.kill).not.toHaveBeenCalled();
    expect(supervisor.isRunning).toBe(true);
  });

  test("session counter + idle timeout: timer arms at zero, cancels on new session, fires on expiry", async () => {
    harness = makeHarness({
      idleTimeoutMs: 20,
      gracefulExitGraceMs: 5,
      sigkillGraceMs: 5,
    });
    const { supervisor, connectFn, child } = harness;

    const p = supervisor.ensureRunning();
    await tick();
    supervisor.notifyHandshake({ sourceHash: "hash-abc" });
    await p;

    // Start + end two sessions, cancelling/arming the timer.
    supervisor.reportSessionStarted("s1");
    supervisor.reportSessionStarted("s2");
    expect(supervisor.activeSessionCount).toBe(2);

    supervisor.reportSessionEnded("s1");
    // s2 still active — idle timer must NOT be armed.
    expect(supervisor.activeSessionCount).toBe(1);

    supervisor.reportSessionEnded("s2");
    expect(supervisor.activeSessionCount).toBe(0);

    // A second start before the timer fires must cancel it.
    supervisor.reportSessionStarted("s3");
    supervisor.reportSessionEnded("s3");
    // Timer re-armed — wait past its expiry.
    await new Promise((r) => setTimeout(r, 40));

    // After idle expiry the supervisor should try to send skill.shutdown
    // over the control socket; our fake socket records that write.
    expect(connectFn).toHaveBeenCalled();
    // Let the kill / exit microtasks settle.
    await new Promise((r) => setTimeout(r, 20));
    expect(child.exitCode).not.toBeNull();
  });

  test("crash after startup nulls the handle; next ensureRunning re-spawns", async () => {
    harness = makeHarness();
    const { supervisor, spawnFn, child: firstChild } = harness;

    const p = supervisor.ensureRunning();
    await tick();
    supervisor.notifyHandshake({ sourceHash: "hash-abc" });
    await p;
    expect(supervisor.isRunning).toBe(true);

    // Simulate an unexpected crash of the first child.
    firstChild.simulateExit(137, "SIGKILL");
    expect(supervisor.isRunning).toBe(false);

    // Next ensureRunning must spawn a fresh child. Swap the spawn
    // factory so a distinct FakeChild shows up for the second call.
    const secondChild = new FakeChild();
    spawnFn.mockImplementation(() => secondChild as unknown as ChildProcess);

    const p2 = supervisor.ensureRunning();
    await tick();
    supervisor.notifyHandshake({ sourceHash: "hash-abc" });
    await p2;
    expect(spawnFn).toHaveBeenCalledTimes(2);
    expect(supervisor.isRunning).toBe(true);
  });

  test("shutdown stops the child and is safe to call twice", async () => {
    harness = makeHarness();
    const { supervisor, child } = harness;

    const p = supervisor.ensureRunning();
    await tick();
    supervisor.notifyHandshake({ sourceHash: "hash-abc" });
    await p;

    await supervisor.shutdown();
    expect(child.exitCode).not.toBeNull();

    // A second shutdown is a no-op.
    await supervisor.shutdown();
    // ensureRunning after shutdown should reject — supervisor is done.
    await expect(supervisor.ensureRunning()).rejects.toThrow(/shutting down/);
  });
});

describe("MeetHostSupervisor dispatch", () => {
  let harness: Harness;

  afterEach(async () => {
    try {
      await harness?.supervisor.shutdown();
    } catch {
      // Best-effort cleanup
    }
    __clearGlobalSkillIpcSenderForTesting();
  });

  beforeEach(() => {
    harness = undefined as unknown as Harness;
  });

  /** Stub `SkillIpcConnection` shape — only `connectionId` is read by logs. */
  function fakeConnection(id = "conn-1") {
    return {
      connectionId: id,
      addRouteHandle: () => undefined,
      addSkillToolsOwner: () => undefined,
    } as unknown as Parameters<
      InstanceType<typeof MeetHostSupervisor>["setActiveConnection"]
    >[0];
  }

  test("dispatchTool sends skill.dispatch_tool on the active connection and unwraps result", async () => {
    harness = makeHarness({
      sendRequestImpl: async (..._args) => ({
        result: { joinUrl: "https://example.test/m/abc" },
      }),
    });
    const { supervisor, sendRequest } = harness;

    // Bring the child up and register a connection so dispatch has a target.
    const p = supervisor.ensureRunning();
    await tick();
    supervisor.notifyHandshake({ sourceHash: "hash-abc" });
    await p;
    const conn = fakeConnection();
    supervisor.setActiveConnection(conn);

    const out = await supervisor.dispatchTool(
      "meet_demo",
      { url: "x" },
      { conversationId: "c" },
    );
    expect(out).toEqual({ joinUrl: "https://example.test/m/abc" });
    expect(sendRequest).toHaveBeenCalledTimes(1);
    const call = sendRequest.mock.calls[0] as [
      unknown,
      string,
      Record<string, unknown>,
    ];
    expect(call[1]).toBe("skill.dispatch_tool");
    expect(call[2]).toEqual({
      name: "meet_demo",
      input: { url: "x" },
      context: { conversationId: "c" },
    });
  });

  test("dispatchTool propagates remote errors from the sender", async () => {
    harness = makeHarness({
      sendRequestImpl: async () => {
        throw new Error("remote: kaboom");
      },
    });
    const { supervisor } = harness;

    const p = supervisor.ensureRunning();
    await tick();
    supervisor.notifyHandshake({ sourceHash: "hash-abc" });
    await p;
    supervisor.setActiveConnection(fakeConnection());

    await expect(supervisor.dispatchTool("meet_demo", {}, {})).rejects.toThrow(
      /kaboom/,
    );
  });

  test("dispatchTool throws when no IPC connection is registered", async () => {
    harness = makeHarness();
    const { supervisor } = harness;

    const p = supervisor.ensureRunning();
    await tick();
    supervisor.notifyHandshake({ sourceHash: "hash-abc" });
    await p;
    // Intentionally do NOT call setActiveConnection.

    await expect(supervisor.dispatchTool("meet_demo", {}, {})).rejects.toThrow(
      /no IPC connection was registered/,
    );
  });

  test("dispatchRoute sends skill.dispatch_route and returns the response envelope", async () => {
    const envelope = {
      status: 202,
      headers: { "x-skill": "meet" },
      body: '{"received":true}',
    };
    harness = makeHarness({ sendRequestImpl: async () => envelope });
    const { supervisor, sendRequest } = harness;

    const p = supervisor.ensureRunning();
    await tick();
    supervisor.notifyHandshake({ sourceHash: "hash-abc" });
    await p;
    supervisor.setActiveConnection(fakeConnection());

    const result = await supervisor.dispatchRoute("^/api/skills/meet$", {
      method: "POST",
      url: "http://localhost/api/skills/meet",
      body: '{"hi":1}',
    });
    expect(result).toEqual(envelope);
    expect(sendRequest).toHaveBeenCalledTimes(1);
    const call = sendRequest.mock.calls[0] as [
      unknown,
      string,
      Record<string, unknown>,
    ];
    expect(call[1]).toBe("skill.dispatch_route");
    expect(call[2].patternSource).toBe("^/api/skills/meet$");
  });

  test("dispatchShutdown is a no-op when no active connection is set", async () => {
    harness = makeHarness();
    const { supervisor, sendRequest } = harness;

    // No spawn; dispatchShutdown should silently return.
    await supervisor.dispatchShutdown("hook-x", "test");
    expect(sendRequest).not.toHaveBeenCalled();
  });

  test("dispatchShutdown sends skill.shutdown when a connection is active", async () => {
    harness = makeHarness();
    const { supervisor, sendRequest } = harness;

    const p = supervisor.ensureRunning();
    await tick();
    supervisor.notifyHandshake({ sourceHash: "hash-abc" });
    await p;
    supervisor.setActiveConnection(fakeConnection());

    await supervisor.dispatchShutdown("hook-x", "daemon-shutdown");
    expect(sendRequest).toHaveBeenCalledTimes(1);
    const call = sendRequest.mock.calls[0] as [
      unknown,
      string,
      Record<string, unknown>,
    ];
    expect(call[1]).toBe("skill.shutdown");
    expect(call[2]).toEqual({ name: "hook-x", reason: "daemon-shutdown" });
  });

  test("setActiveConnection / clearActiveConnection are idempotent", async () => {
    harness = makeHarness();
    const { supervisor } = harness;

    const p = supervisor.ensureRunning();
    await tick();
    supervisor.notifyHandshake({ sourceHash: "hash-abc" });
    await p;

    const conn = fakeConnection();
    supervisor.setActiveConnection(conn);
    // Re-set with the same connection: no-op (idempotency).
    supervisor.setActiveConnection(conn);

    supervisor.clearActiveConnection();
    // Second clear: idempotent no-op.
    supervisor.clearActiveConnection();

    // dispatchShutdown after clear is silently a no-op (no connection,
    // returns without sending).
    await supervisor.dispatchShutdown("hook-x", "test");
    expect(harness.sendRequest).not.toHaveBeenCalled();
  });

  test("shutdown clears the active connection", async () => {
    harness = makeHarness();
    const { supervisor } = harness;

    const p = supervisor.ensureRunning();
    await tick();
    supervisor.notifyHandshake({ sourceHash: "hash-abc" });
    await p;

    supervisor.setActiveConnection(fakeConnection());
    await supervisor.shutdown();

    // dispatchShutdown after full shutdown: silent no-op (no connection).
    await supervisor.dispatchShutdown("hook-x", "test");
    expect(harness.sendRequest).not.toHaveBeenCalled();
  });
});
