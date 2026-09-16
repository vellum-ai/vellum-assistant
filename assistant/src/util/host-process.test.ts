import { EventEmitter } from "node:events";
import { expect, mock, test } from "bun:test";

import { terminateProcessTree, watchShellProcessStart } from "./host-process.js";

test("Windows process trees use taskkill and fall back to the direct child", () => {
  const kill = mock(() => true);
  let taskkillPid: number | undefined;

  terminateProcessTree({ pid: 1234, kill }, "win32", (pid, onFailure) => {
    taskkillPid = pid;
    onFailure();
  });

  expect(taskkillPid).toBe(1234);
  expect(kill).toHaveBeenCalledTimes(1);
  expect(kill).toHaveBeenCalledWith();
});

test("watchShellProcessStart is false until spawn or a pid appears", () => {
  const child = new EventEmitter() as EventEmitter & { pid?: number };
  const launch = watchShellProcessStart(child);
  expect(launch.didStart()).toBe(false);

  child.emit("spawn");
  expect(launch.didStart()).toBe(true);
});

test("watchShellProcessStart treats a pid assigned at construction as started", () => {
  const child = new EventEmitter() as EventEmitter & { pid?: number };
  child.pid = 4242;
  expect(watchShellProcessStart(child).didStart()).toBe(true);
});
