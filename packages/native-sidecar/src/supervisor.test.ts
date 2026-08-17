import { describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { z } from "zod";

import { SidecarSupervisor } from "./process-supervisor";
import { NativeSidecarClient } from "./supervisor";

class FakeChild extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly writes: string[] = [];
  readonly stdin = {
    write: (value: string, callback?: (error?: Error | null) => void) => {
      this.writes.push(value);
      callback?.(null);
      return true;
    },
    end: mock(() => undefined),
  };
  readonly kill = mock((_signal?: NodeJS.Signals) => true);
  readonly pid = 1234;
}

const asChild = (child: FakeChild): ChildProcessWithoutNullStreams =>
  child as unknown as ChildProcessWithoutNullStreams;

const logger = () => ({ info: mock(() => {}), warn: mock(() => {}) });

describe("NativeSidecarClient", () => {
  test("routes responses, notifications, malformed frames, and stderr", async () => {
    const child = new FakeChild();
    const logs = logger();
    const client = new NativeSidecarClient({
      name: "test helper",
      resolveExecutablePath: () => "unused",
      logger: logs,
      platform: "win32",
      spawn: () => asChild(child),
      maxFrameBytes: 256,
    });
    const notifications: string[] = [];
    client.onNotification(
      "status.changed",
      z.object({ state: z.string() }),
      ({ state }) => notifications.push(state),
    );

    const response = client.call("system.ping", { value: 1 });
    expect(JSON.parse(child.writes[0]!)).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      method: "system.ping",
    });
    child.stderr.emit("data", Buffer.from("diagnostic\n"));
    child.stdout.emit("data", Buffer.from("x".repeat(257)));
    child.stdout.emit(
      "data",
      Buffer.from(
        'not-json\n{"jsonrpc":"2.0","method":"status.changed","params":{"state":"ready"}}\n{"jsonrpc":"2.0","id":1,"result":"pong"}\n',
      ),
    );

    expect(await response).toBe("pong");
    expect(notifications).toEqual(["ready"]);
    expect(logs.warn).toHaveBeenCalledTimes(3);
    client.shutdown({ method: "system.shutdown" });
    expect(child.stdin.end).toHaveBeenCalledTimes(1);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  test("rejects pending calls when the helper exits", async () => {
    const child = new FakeChild();
    const client = new NativeSidecarClient({
      name: "test helper",
      resolveExecutablePath: () => "unused",
      logger: logger(),
      platform: "darwin",
      spawn: () => asChild(child),
      initialBackoffMs: 50,
    });

    const response = client.call("slow.operation");
    child.emit("close", 1, null);
    await expect(response).rejects.toThrow("exited before response");
    client.shutdown();
  });
});

test("SidecarSupervisor bounds crash loops with a circuit breaker", async () => {
  const children: FakeChild[] = [];
  const supervisor = new SidecarSupervisor({
    name: "test helper",
    logger: logger(),
    spawn: () => {
      const child = new FakeChild();
      children.push(child);
      return asChild(child);
    },
    initialBackoffMs: 1,
    maxBackoffMs: 1,
    circuitCrashCount: 3,
    circuitWindowMs: 1_000,
  });

  supervisor.ensureRunning();
  for (let index = 0; index < 3; index += 1) {
    children[index]!.emit("close", 1, null);
    await Bun.sleep(5);
  }

  expect(children).toHaveLength(3);
  expect(supervisor.getState().status).toBe("circuit-open");
  expect(supervisor.ensureRunning()).toBeNull();
});
