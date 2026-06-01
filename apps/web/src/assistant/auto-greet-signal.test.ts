import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  __resetAutoGreetSignalForTesting,
  consumeAutoGreetPending,
  peekAutoGreetPending,
  setAutoGreetPending,
} from "./auto-greet-signal";

beforeEach(() => {
  __resetAutoGreetSignalForTesting();
});

afterEach(() => {
  __resetAutoGreetSignalForTesting();
});

describe("auto-greet-signal", () => {
  test("peek returns false when nothing was set", () => {
    expect(peekAutoGreetPending()).toBe(false);
  });

  test("set → peek returns true without clearing", () => {
    setAutoGreetPending();
    expect(peekAutoGreetPending()).toBe(true);
    expect(peekAutoGreetPending()).toBe(true);
  });

  test("set → consume returns true and clears for subsequent reads", () => {
    setAutoGreetPending();
    expect(consumeAutoGreetPending()).toBe(true);
    expect(peekAutoGreetPending()).toBe(false);
    expect(consumeAutoGreetPending()).toBe(false);
  });

  test("consume without a prior set returns false and is a no-op", () => {
    expect(consumeAutoGreetPending()).toBe(false);
    expect(peekAutoGreetPending()).toBe(false);
  });
});
