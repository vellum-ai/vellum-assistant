/**
 * The marker a list-pushed detail entry carries, and the two ways of leaving
 * such a detail: pop back to the list it was pushed from, or replace when
 * nothing pushed it.
 */
import { describe, expect, mock, test } from "bun:test";
import type { NavigateFunction } from "react-router";

import {
  PUSHED_FROM_LIST_STATE,
  returnToList,
  wasPushedFromList,
} from "@/utils/list-detail-navigation";

const navigateMock = () => mock(() => {}) as unknown as NavigateFunction;

describe("wasPushedFromList", () => {
  test("recognizes the marker", () => {
    expect(wasPushedFromList(PUSHED_FROM_LIST_STATE)).toBe(true);
  });

  test("rejects an absent or empty state", () => {
    expect(wasPushedFromList(null)).toBe(false);
    expect(wasPushedFromList(undefined)).toBe(false);
    expect(wasPushedFromList({})).toBe(false);
  });

  test("rejects a truthy value that is not the boolean", () => {
    expect(wasPushedFromList({ pushedFromList: "yes" })).toBe(false);
  });
});

describe("returnToList", () => {
  test("pops the pushed detail entry", () => {
    const navigate = navigateMock();
    returnToList(navigate, PUSHED_FROM_LIST_STATE, "/x");
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith(-1);
  });

  test("replaces when nothing pushed the detail", () => {
    const navigate = navigateMock();
    returnToList(navigate, null, "/x");
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith("/x", { replace: true });
  });
});
