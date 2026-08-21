import { expect, mock, test } from "bun:test";

import { terminateProcessTree } from "./host-process.js";

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
