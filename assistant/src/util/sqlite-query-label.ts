/**
 * Ambient attribution label for SQLite statements, carried across an async
 * call tree via `AsyncLocalStorage`.
 *
 * The slow-query reporter ({@link ../persistence/slow-query-log}) attributes
 * an unlabeled statement by walking the stack, but some execution paths leave
 * no usable application frame: a lazy Drizzle query awaited by a wrapper runs
 * from a microtask, and a retried statement (after a backoff sleep) runs from
 * a truncated stack that bottoms out in the retry helper itself. Wrappers that
 * *do* know what operation they are running — {@link ./sqlite-retry
 * withSqliteRetry} with its curated `op` — publish that name here, and the
 * reporter reads it on the slow path as the statement's label.
 *
 * This module lives in `util/` (not beside the reporter in `persistence/`)
 * because `util/` must not import from `persistence/`; both sides depend on
 * this small shared seam instead.
 *
 * Scoping: the label applies to every statement executed inside `fn`'s
 * synchronous and awaited continuations — exactly the work the wrapper is
 * accountable for — and evaporates when `fn` settles. Nested scopes shadow
 * naturally (innermost wins), and an explicit statement-level `.label()`
 * always takes precedence over an ambient label.
 */

import { AsyncLocalStorage } from "node:async_hooks";

const ambientLabel = new AsyncLocalStorage<string>();

/**
 * Run `fn` (sync or async) with `label` as the ambient SQLite query label.
 * Returns `fn`'s result unchanged; for an async `fn` the label stays in
 * effect across its awaits.
 *
 * Caveat: the label covers only work performed *inside* the scope. If `fn`
 * returns a lazy thenable (a Drizzle QueryPromise executes its statement when
 * first awaited), the caller's own `await` happens after this scope has
 * exited — pass `async () => await lazy()` so assimilation, and therefore the
 * query, runs inside the scope.
 */
export function runWithSqliteQueryLabel<T>(label: string, fn: () => T): T {
  return ambientLabel.run(label, fn);
}

/**
 * The innermost ambient label in effect, or `undefined` outside any
 * {@link runWithSqliteQueryLabel} scope. Read by the slow-query reporter on
 * its slow path only — never on the per-statement fast path.
 */
export function getAmbientSqliteQueryLabel(): string | undefined {
  return ambientLabel.getStore();
}
