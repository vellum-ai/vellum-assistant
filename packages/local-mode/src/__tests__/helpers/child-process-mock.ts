import { EventEmitter } from "node:events";
import { mock } from "bun:test";

/**
 * Stand-in for the `ChildProcess` a mocked `spawn` returns. Tests drive it by
 * emitting `"close"` / `"error"` on the instance and `"data"` on its streams.
 */
export class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = mock(() => true);
}

/** Any stand-in for `spawn`; each suite records the arguments it asserts on. */
type SpawnReplacement = (...args: never[]) => unknown;

/**
 * Replace `spawn` in `node:child_process` while leaving every other export of
 * the module intact.
 *
 * `mock.module()` is process-global, and a registration that lands before
 * anything in the process has loaded `node:child_process` installs the
 * factory's object as the entire module. A factory returning only `{ spawn }`
 * therefore strips `spawnSync` and the rest for every module linked
 * afterwards. `src/lockfile-lock.test.ts` imports `spawnSync` at module scope
 * and fails to link with "Export named 'spawnSync' not found in module
 * 'node:child_process'" once that happens, and since bun runs a package's test
 * files in one process, whether it happens depends on file ordering.
 *
 * Two things keep the namespace whole:
 *
 * 1. Awaiting the real module materializes it before `mock.module()`
 *    registers. Bun patches that live namespace in place, so the exports the
 *    factory does not name keep their real values. This is the property that
 *    prevents the link error.
 * 2. The factory returns a plain copy of the namespace captured before
 *    registration, so the replacement is complete on its own terms and never
 *    reads back through the namespace being patched. Spreading a live,
 *    already-mocked namespace inside a factory is the shape that
 *    `cli/src/__tests__/helpers/os-mock.ts` documents as recursing forever.
 *
 * Every `node:child_process` spawn mock in this package routes through here so
 * both hold for all of them at once. Call it once at module scope, with
 * `await`, before the module under test is imported.
 */
export async function mockChildProcessSpawn(
  spawnMock: SpawnReplacement,
): Promise<void> {
  const realChildProcess = await import("node:child_process");
  const realChildProcessSnapshot = { ...realChildProcess };
  mock.module("node:child_process", () => ({
    ...realChildProcessSnapshot,
    spawn: spawnMock,
  }));
}
