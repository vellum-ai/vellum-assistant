/**
 * Shared test helper: stub `Bun.which` for ACP tests.
 *
 * `Bun.which` is a process-global. `mock.module` only intercepts ESM module
 * exports, so it can't touch globals — every ACP test that exercises the
 * resolver's PATH preflight ends up writing the same boilerplate to swap
 * `Bun.which` and restore it in `afterAll`. This helper consolidates that
 * setup. Because the swap is process-global the helper itself is also
 * process-global: each test file should call `installWhichStub()` once at
 * the top level, drive it via `setWhich(map)` per test, and call `restore()`
 * in `afterAll` so the swap doesn't leak into other files.
 */

type WhichOptions = { PATH?: string; cwd?: string };
type WhichStub = (command: string, options?: WhichOptions) => string | null;

/**
 * Installs a process-global stub for Bun.which. Returns helpers to drive and
 * restore it.
 *
 * `setWhich(map)` updates the stub so each `Bun.which(cmd)` call returns
 * `map[cmd] ?? null`. The function form lets callers express "every command
 * resolves" (the default ACP test setup) without enumerating every binary
 * the resolver might probe.
 */
export function installWhichStub(): {
  setWhich(map: Record<string, string | null>): void;
  setWhich(fn: WhichStub): void;
  restore(): void;
} {
  const originalWhich = Bun.which;
  let whichStub: WhichStub = () => null;

  (Bun as unknown as { which: WhichStub }).which = (cmd, options) =>
    whichStub(cmd, options);

  function setWhich(arg: Record<string, string | null> | WhichStub): void {
    whichStub = typeof arg === "function" ? arg : (cmd) => arg[cmd] ?? null;
  }

  return {
    setWhich,
    restore(): void {
      (Bun as unknown as { which: typeof originalWhich }).which = originalWhich;
    },
  };
}
