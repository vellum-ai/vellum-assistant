/**
 * Installing a `mock.module` without erasing the module or leaking it.
 *
 * `mock.module` is process-global in bun. A replacement that does not spread
 * the real module erases every other export of it for whatever file loads it
 * next, and one that is never put back outlives the file that installed it.
 * Both halves were being written by hand at each mock site, which is two
 * chances per mock to forget one.
 *
 * The real module is passed in rather than imported here: a module namespace's
 * bindings are live, so reading an export back after the mock is installed
 * hands out the mock, and the capture has to happen at the call site before
 * the replacement lands.
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
 */
export function stubModule(
  specifier: string,
  real: object,
  overrides: Record<string, unknown>,
): void {
  const captured = { ...real } as Record<string, unknown>;
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
