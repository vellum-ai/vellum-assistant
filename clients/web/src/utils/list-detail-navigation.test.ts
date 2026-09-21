/**
 * The two ways of leaving a list-detail screen: pop back to the list the entry
 * was pushed from, or replace when nothing pushed it.
 */
import { describe, expect, mock, test } from "bun:test";
import type { NavigateFunction } from "react-router";

import {
  PUSHED_FROM_LIST_STATE,
  returnToList,
} from "@/utils/list-detail-navigation";

const navigateMock = () => mock(() => {}) as unknown as NavigateFunction;

describe("returnToList", () => {
  test("pops the pushed detail entry", () => {
    const navigate = navigateMock();
    returnToList(navigate, PUSHED_FROM_LIST_STATE, "/x");
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith(-1);
  });

  test.each([
    ["absent", null],
    ["empty", {}],
    ["malformed", { pushedFromList: "yes" }],
  ])("replaces when the marker is %s", (_name, state) => {
    const navigate = navigateMock();
    returnToList(navigate, state, "/x");
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith("/x", { replace: true });
  });
});
