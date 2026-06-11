import { describe, expect, test } from "bun:test";

import { filterRecords, num, rec, str, strOrNum } from "./surface-parse-helpers";

describe("str", () => {
  test("returns string values", () => {
    expect(str("hello")).toBe("hello");
    expect(str("")).toBe("");
  });

  test("returns undefined for non-strings", () => {
    expect(str(42)).toBeUndefined();
    expect(str(null)).toBeUndefined();
    expect(str(undefined)).toBeUndefined();
    expect(str(true)).toBeUndefined();
    expect(str({})).toBeUndefined();
    expect(str([])).toBeUndefined();
  });
});

describe("num", () => {
  test("returns finite numbers", () => {
    expect(num(42)).toBe(42);
    expect(num(0)).toBe(0);
    expect(num(-3.14)).toBe(-3.14);
  });

  test("coerces numeric strings", () => {
    expect(num("72")).toBe(72);
    expect(num("3.5")).toBe(3.5);
  });

  test("rejects empty strings and whitespace-only strings", () => {
    expect(num("")).toBeUndefined();
    expect(num("  ")).toBeUndefined();
    expect(num("\t")).toBeUndefined();
  });

  test("rejects booleans", () => {
    expect(num(true)).toBeUndefined();
    expect(num(false)).toBeUndefined();
  });

  test("returns undefined for non-finite or non-numeric", () => {
    expect(num(NaN)).toBeUndefined();
    expect(num(Infinity)).toBeUndefined();
    expect(num(-Infinity)).toBeUndefined();
    expect(num("hello")).toBeUndefined();
    expect(num(null)).toBeUndefined();
    expect(num(undefined)).toBeUndefined();
    expect(num({})).toBeUndefined();
  });
});

describe("rec", () => {
  test("returns plain objects", () => {
    const obj = { a: 1, b: "two" };
    expect(rec(obj)).toBe(obj);
  });

  test("returns undefined for non-objects", () => {
    expect(rec(null)).toBeUndefined();
    expect(rec(undefined)).toBeUndefined();
    expect(rec("string")).toBeUndefined();
    expect(rec(42)).toBeUndefined();
    expect(rec(true)).toBeUndefined();
  });

  test("returns undefined for arrays", () => {
    expect(rec([1, 2, 3])).toBeUndefined();
    expect(rec([])).toBeUndefined();
  });
});

describe("strOrNum", () => {
  test("returns strings", () => {
    expect(strOrNum("hello")).toBe("hello");
    expect(strOrNum("")).toBe("");
  });

  test("returns numbers", () => {
    expect(strOrNum(42)).toBe(42);
    expect(strOrNum(0)).toBe(0);
  });

  test("returns undefined for other types", () => {
    expect(strOrNum(null)).toBeUndefined();
    expect(strOrNum(undefined)).toBeUndefined();
    expect(strOrNum(true)).toBeUndefined();
    expect(strOrNum({})).toBeUndefined();
    expect(strOrNum([])).toBeUndefined();
  });
});

describe("filterRecords", () => {
  test("returns empty array for non-array input", () => {
    expect(filterRecords(null)).toEqual([]);
    expect(filterRecords(undefined)).toEqual([]);
    expect(filterRecords("string")).toEqual([]);
    expect(filterRecords(42)).toEqual([]);
    expect(filterRecords({})).toEqual([]);
  });

  test("filters out non-object items", () => {
    const input = [{ a: 1 }, null, "string", 42, { b: 2 }, undefined, true];
    expect(filterRecords(input)).toEqual([{ a: 1 }, { b: 2 }]);
  });

  test("filters out arrays nested in the array", () => {
    const input = [{ a: 1 }, [1, 2], { b: 2 }];
    expect(filterRecords(input)).toEqual([{ a: 1 }, { b: 2 }]);
  });

  test("returns empty array for empty array input", () => {
    expect(filterRecords([])).toEqual([]);
  });
});
