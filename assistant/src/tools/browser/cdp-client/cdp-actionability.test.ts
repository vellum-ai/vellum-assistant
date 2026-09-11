import { expect, test } from "bun:test";

import { actionableElement } from "./cdp-actionability.js";
import type { CdpClient } from "./types.js";

function client(values: unknown[]): CdpClient {
  return {
    send: async <T>() => ({ result: { value: values.shift() } }) as T,
    dispose() {},
  };
}

test("rejects an unavailable or obstructed element", async () => {
  await expect(
    actionableElement(
      client([null]),
      "node",
      false,
      new AbortController().signal,
    ),
  ).rejects.toThrow("covered");
});

test("rejects a moving element and accepts a stable box", async () => {
  const box = { x: 10, y: 20, width: 40, height: 20 };
  await expect(
    actionableElement(
      client([box, { ...box, x: 30 }]),
      "node",
      false,
      new AbortController().signal,
    ),
  ).rejects.toThrow("moving");
  expect(
    await actionableElement(
      client([box, box]),
      "node",
      false,
      new AbortController().signal,
    ),
  ).toEqual(box);
});

test("cancellation between stability samples prevents the next CDP call", async () => {
  const abort = new AbortController();
  let calls = 0;
  const cdp: CdpClient = {
    send: async <T>() => {
      calls += 1;
      abort.abort();
      return { result: { value: { x: 1, y: 2, width: 3, height: 4 } } } as T;
    },
    dispose() {},
  };
  await expect(
    actionableElement(cdp, "node", true, abort.signal),
  ).rejects.toBeDefined();
  expect(calls).toBe(1);
});
