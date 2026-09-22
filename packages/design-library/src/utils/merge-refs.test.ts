import { describe, expect, test } from "bun:test";
import { createRef } from "react";

import { mergeRefs } from "./merge-refs";

const node = { id: "element" };
type Node = typeof node;

describe("mergeRefs", () => {
  test("hands the element to every ref and takes it back on detach", () => {
    const object = createRef<Node>();
    const calls: (Node | null)[] = [];
    const detach = mergeRefs<Node>(object, (value) => {
      calls.push(value);
    })(node);

    expect(object.current).toBe(node);
    expect(calls).toEqual([node]);

    detach?.();
    expect(object.current).toBeNull();
    expect(calls).toEqual([node, null]);
  });

  test("runs a callback ref's own cleanup instead of calling it with null", () => {
    const calls: (Node | null)[] = [];
    let cleanedUp = 0;
    const detach = mergeRefs<Node>((value) => {
      calls.push(value);
      return () => {
        cleanedUp += 1;
      };
    })(node);

    detach?.();
    expect(cleanedUp).toBe(1);
    expect(calls).toEqual([node]);
  });

  test("skips a ref the caller left out", () => {
    const object = createRef<Node>();
    const detach = mergeRefs<Node>(undefined, null, object)(node);

    expect(object.current).toBe(node);
    detach?.();
    expect(object.current).toBeNull();
  });

  test("detaches every ref when one cleanup throws, then rethrows", () => {
    const object = createRef<Node>();
    const failure = new Error("cleanup failed");
    const detach = mergeRefs<Node>(
      () => () => {
        throw failure;
      },
      object,
    )(node);

    expect(() => detach?.()).toThrow(failure);
    expect(object.current).toBeNull();
  });
});
