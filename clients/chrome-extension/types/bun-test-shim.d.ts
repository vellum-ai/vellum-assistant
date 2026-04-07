/**
 * Minimal shim for the `bun:test` module so the chrome-extension tests
 * can be type-checked without depending on bun-types being installed in
 * the chrome-extension's own node_modules. The full bun-types package is
 * available in assistant/node_modules and is the runtime source of truth;
 * this shim only declares the surface used by the extension's unit tests.
 */

declare module 'bun:test' {
  type TestFn = () => void | Promise<void>;

  export function describe(name: string, fn: () => void): void;
  export function test(name: string, fn: TestFn): void;
  export function beforeEach(fn: TestFn): void;
  export function afterEach(fn: TestFn): void;

  interface Matchers<R> {
    toBe(expected: unknown): R;
    toEqual(expected: unknown): R;
    toBeNull(): R;
    toBeUndefined(): R;
    toBeGreaterThanOrEqual(expected: number): R;
    toBeLessThanOrEqual(expected: number): R;
    toContain(expected: unknown): R;
    not: Matchers<R>;
    rejects: {
      toThrow(expected?: string | RegExp | Error): Promise<void>;
    };
    toThrow(expected?: string | RegExp | Error): R;
  }

  export function expect<T>(actual: T): Matchers<void>;
}
