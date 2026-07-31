/**
 * Shared test helper: a recursive no-op logger mock.
 *
 * The naive pattern that several tests use — `getLogger: () => new Proxy({},
 * { get: () => () => {} })` — silently breaks when any consumer calls
 * `log.child({...}).<method>()`. The `.child()` thunk returns `undefined`,
 * so `undefined.<method>` throws a TypeError. This usually doesn't surface in
 * isolation, because the success path of most code under test doesn't call
 * `.child()`. But Bun's `mock.module()` DOES NOT hoist above static imports
 * in the same file: the test file's own `import { runAgentLoopImpl } from …`
 * statement triggers a transitive import chain that calls `getLogger` AT
 * MODULE-INIT TIME, BEFORE the test file's `mock.module(...)` runs. If a
 * previous test file in the same `bun test` run installed a non-recursive
 * proxy mock for `util/logger.js`, that mock is now active for every newly
 * loaded module — and any path that touches `log.child(...)` blows up.
 *
 * This helper installs a recursive proxy whose `child` access returns another
 * proxy of the same shape, so every `log.<method>(...)` and
 * `log.child({...}).<method>(...)` call is a safe no-op regardless of how
 * deep callers nest.
 *
 * Usage:
 *
 *   import { mock } from "bun:test";
 *   import { makeMockLogger } from "./helpers/mock-logger.js";
 *
 *   mock.module("../util/logger.js", () => ({
 *     getLogger: () => makeMockLogger(),
 *   }));
 */

export function makeMockLogger(): unknown {
  return new Proxy({} as Record<string, unknown>, {
    get: (_target, prop) => (prop === "child" ? makeMockLogger : () => {}),
  });
}

/**
 * Returns a complete mock module object for `util/logger.js`. Use this when
 * the consumer of `mock.module("../util/logger.js", ...)` needs full export
 * coverage — i.e. when the transitive import graph reaches `getCliLogger`,
 * `initLogger`, or other helpers in addition to `getLogger`.
 *
 *   mock.module("../util/logger.js", () => createMockLoggerModule());
 *
 * Pass `overrides` to swap any specific export for a custom stub (e.g. an
 * observable spy). Anything not overridden falls back to the recursive
 * proxy logger / no-op defaults.
 */
export function createMockLoggerModule(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    getLogger: () => makeMockLogger(),
    getCliLogger: () => makeMockLogger(),
    initLogger: () => {},
    truncateForLog: (value: string) => value,
    pruneOldLogFiles: () => 0,
    getCurrentLogFilePath: () => "/tmp/assistant-test-mock.log",
    LOG_FILE_PATTERN: /^assistant-(\d{4}-\d{2}-\d{2})\.log$/,
    ...overrides,
  };
}
