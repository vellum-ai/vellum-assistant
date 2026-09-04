/**
 * Installing a `mock.module` without erasing the module or leaking it.
 *
 * `mock.module` is process-global in bun. A replacement that does not spread
 * the real module erases every other export of it for whatever file loads it
 * next, and one that is never put back outlives the file that installed it.
 * This helper owns both halves: it spreads a by-value capture of the real
 * module under the overrides, and it records how to put that module back.
 *
 * The real module is passed in rather than imported here: a module namespace's
 * bindings are live, so reading an export back after the mock is installed
 * hands out the mock, and the capture has to happen at the call site before
 * the replacement lands.
 *
 * One restorer map serves the whole process. `scripts/run-tests.ts` gives each
 * test file its own process, and bun runs files sequentially otherwise, so no
 * two suites hold entries in the map at the same time and restoring in
 * `afterAll` is safe.
 *
 * Lives in the top-level shared utils because the suites that need it sit in
 * `hooks/` and in more than one domain.
 */

import { mock } from "bun:test";

/** How to put each stubbed module back, keyed by specifier. */
const restorers = new Map<string, () => void>();

/**
 * Replace `specifier` with the real module plus `overrides`, and register the
 * undo. Hand `restoreStubbedModules` to the suite's `afterAll`.
 *
 * `overrides` is typed against the module being replaced, so a misspelled
 * export name or a value the module's consumers cannot use is a compile error
 * rather than an `undefined` the suite reads as a passing branch.
 */
export function stubModule<M extends object>(
  specifier: string,
  real: M,
  overrides: Partial<M>,
): void {
  const captured = { ...real } as M;
  mock.module(specifier, () => ({ ...captured, ...overrides }));
  restorers.set(specifier, () => {
    mock.module(specifier, () => captured);
  });
}

/** Put every module {@link stubModule} replaced back the way it was. */
export function restoreStubbedModules(): void {
  for (const restore of restorers.values()) {
    restore();
  }
  restorers.clear();
}
