import { afterEach, describe, expect, test } from "bun:test";
import { act, renderHook } from "@testing-library/react";

import { LS_ASSISTANT_INBOX_READ_EMAILS_PREFIX } from "@/utils/local-settings-keys";

import { readReadEmailIds, useReadEmails } from "./use-read-emails";

const ASSISTANT = "asst-1";
const KEY = `${LS_ASSISTANT_INBOX_READ_EMAILS_PREFIX}${ASSISTANT}`;

afterEach(() => {
  localStorage.clear();
});

describe("useReadEmails", () => {
  test("marking a message read persists it and keeps assistants apart", () => {
    const { result } = renderHook(() => useReadEmails(ASSISTANT));
    expect(result.current.readIds.size).toBe(0);

    act(() => {
      result.current.markRead("m-1");
    });
    act(() => {
      result.current.markRead("m-1");
    });
    expect(result.current.readIds.has("m-1")).toBe(true);
    expect(readReadEmailIds(ASSISTANT)).toEqual(["m-1"]);
    expect(readReadEmailIds("asst-2")).toEqual([]);
    expect(localStorage.getItem(KEY)).toBe(JSON.stringify(["m-1"]));
  });

  test("a malformed entry reads as none", () => {
    localStorage.setItem(KEY, "not json");
    expect(readReadEmailIds(ASSISTANT)).toEqual([]);
  });
});
