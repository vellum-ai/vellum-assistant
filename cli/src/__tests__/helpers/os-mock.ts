import { mock } from "bun:test";

/**
 * Mock `os.homedir()` (both the `"os"` and `"node:os"` specifiers) while
 * keeping every other os export intact.
 *
 * The factory passed to `mock.module()` must only close over plain snapshots
 * captured before the mock is installed. When another test file has already
 * loaded "os", `mock.module()` patches the live namespace in place — a
 * factory that spreads or calls back through that namespace resolves to the
 * mock itself and recurses forever, a synchronous spin that froze the whole
 * suite (and CI) at whichever file loaded next. This helper owns that
 * invariant so test files don't have to.
 *
 * @param makeHomedir Receives the real (pre-mock) `homedir` and returns the
 *   replacement implementation.
 */
export async function mockOsHomedir(
  makeHomedir: (realHomedir: () => string) => () => string,
): Promise<void> {
  const realOs = await import("node:os");
  const realOsSnapshot = { ...realOs };
  const homedir = makeHomedir(realOs.homedir);
  const factory = () => ({ ...realOsSnapshot, homedir });
  mock.module("node:os", factory);
  mock.module("os", factory);
}
