/**
 * Minimal shim for the `bun:test` module so the chrome-extension tests
 * can be type-checked without depending on bun-types being installed in
 * the chrome-extension's own node_modules. The full bun-types package is
 * available in assistant/node_modules and is the runtime source of truth;
 * this shim only declares the surface used by the extension's unit tests.
 */

declare module 'bun:test' {
  type TestCallback = () => void | Promise<void>;
  type TestFn = (name: string, fn?: TestCallback) => void;

  interface TestApi extends TestFn {
    todo: TestFn;
    skip: TestFn;
    only: TestFn;
  }

  interface DescribeApi {
    (name: string, fn: () => void): void;
    skip(name: string, fn: () => void): void;
    only(name: string, fn: () => void): void;
  }

  export const test: TestApi;
  export const describe: DescribeApi;
  export function beforeEach(fn: TestCallback): void;
  export function afterEach(fn: TestCallback): void;
  export function beforeAll(fn: TestCallback): void;
  export function afterAll(fn: TestCallback): void;

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
