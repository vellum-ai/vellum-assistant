/**
 * Minimal shim for the `bun:test` module so the chrome-extension tests
 * can be type-checked without depending on bun-types being installed in
 * the chrome-extension's own node_modules. The full bun-types package is
 * available in assistant/node_modules and is the runtime source of truth;
 * this shim only declares the surface used by the extension's unit tests.
 */

declare module 'bun:test' {
  type TestCallback = () => void | Promise<void>;

  /** Runnable test: body is required. Applies to test(), test.skip(), test.only(). */
  type RunnableTestFn = (name: string, fn: TestCallback) => void;

  /** Permissive variant for test.todo — a body is optional because
   * a todo can declare intent to write a test in the future. */
  type TodoTestFn = (name: string, fn?: TestCallback) => void;

  interface TestApi extends RunnableTestFn {
    /** Mark a test as a TODO — reports as 'todo' rather than 'passed'.
     * Use for planned tests that haven't been written yet. */
    todo: TodoTestFn;
    /** Skip a test temporarily. Use sparingly; prefer removing or fixing. */
    skip: RunnableTestFn;
    /** Run only this test. Do not commit .only() calls. */
    only: RunnableTestFn;
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
    toBeDefined(): R;
    toEqual(expected: unknown): R;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    toBeInstanceOf(expected: abstract new (...args: any[]) => any): R;
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

  interface ExpectFunction {
    <T>(actual: T): Matchers<void>;
    unreachable(message?: string): never;
  }

  export const expect: ExpectFunction;
}
