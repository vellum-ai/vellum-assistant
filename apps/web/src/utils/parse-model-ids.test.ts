import { describe, expect, test } from "bun:test";

import { parseModelIds } from "@/utils/parse-model-ids";

describe("parseModelIds", () => {
  test("splits, trims, and preserves order", () => {
    expect(parseModelIds("a, b ,c")).toEqual(["a", "b", "c"]);
  });

  test("drops empty and whitespace-only entries", () => {
    expect(parseModelIds("a,,  ,b")).toEqual(["a", "b"]);
  });

  test("returns an empty array for an empty string", () => {
    expect(parseModelIds("")).toEqual([]);
  });
});
