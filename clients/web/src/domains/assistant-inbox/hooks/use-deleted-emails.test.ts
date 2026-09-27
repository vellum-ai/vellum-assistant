import { afterEach, describe, expect, test } from "bun:test";
import { act, renderHook } from "@testing-library/react";

import { LS_ASSISTANT_INBOX_DELETED_EMAILS_PREFIX } from "@/utils/local-settings-keys";

import {
  appendDeletedEmailIds,
  readDeletedEmailIds,
  useDeletedEmails,
} from "./use-deleted-emails";

const ASSISTANT = "asst-1";
const KEY = `${LS_ASSISTANT_INBOX_DELETED_EMAILS_PREFIX}${ASSISTANT}`;

afterEach(() => {
  localStorage.clear();
});

describe("deleted email ids", () => {
  test("an absent or malformed entry reads as none", () => {
    expect(readDeletedEmailIds(ASSISTANT)).toEqual([]);
    localStorage.setItem(KEY, "not json");
    expect(readDeletedEmailIds(ASSISTANT)).toEqual([]);
    localStorage.setItem(KEY, JSON.stringify([1, "m-1", null]));
    expect(readDeletedEmailIds(ASSISTANT)).toEqual(["m-1"]);
  });

  test("appending merges without duplicates and keeps assistants apart", () => {
    appendDeletedEmailIds(ASSISTANT, ["m-1", "m-2"]);
    appendDeletedEmailIds(ASSISTANT, ["m-2", "m-3"]);
    appendDeletedEmailIds("asst-2", ["other"]);
    expect(readDeletedEmailIds(ASSISTANT)).toEqual(["m-1", "m-2", "m-3"]);
    expect(readDeletedEmailIds("asst-2")).toEqual(["other"]);
  });
});

describe("useDeletedEmails", () => {
  test("deleting hides ids live and survives a re-render", () => {
    const { result, rerender } = renderHook(() => useDeletedEmails(ASSISTANT));
    expect(result.current.deletedIds.size).toBe(0);

    act(() => {
      result.current.deleteEmails(["m-1"]);
    });
    expect(result.current.deletedIds.has("m-1")).toBe(true);

    rerender();
    expect(result.current.deletedIds.has("m-1")).toBe(true);
    expect(readDeletedEmailIds(ASSISTANT)).toEqual(["m-1"]);
  });

  test("an empty delete writes nothing", () => {
    const { result } = renderHook(() => useDeletedEmails(ASSISTANT));
    act(() => {
      result.current.deleteEmails([]);
    });
    expect(localStorage.getItem(KEY)).toBeNull();
  });
});
