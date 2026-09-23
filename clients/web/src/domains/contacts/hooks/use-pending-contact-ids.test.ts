import { describe, expect, test } from "bun:test";

import { act, renderHook } from "@testing-library/react";

import { usePendingContactIds } from "@/domains/contacts/hooks/use-pending-contact-ids";

describe("usePendingContactIds", () => {
  test("starts empty", () => {
    const { result } = renderHook(() => usePendingContactIds());

    expect(result.current.ids.size).toBe(0);
  });

  test("holds every id added, and drops the one removed", () => {
    const { result } = renderHook(() => usePendingContactIds());

    act(() => {
      result.current.add("contact-1");
      result.current.add("contact-2");
    });
    expect([...result.current.ids]).toEqual(["contact-1", "contact-2"]);

    act(() => {
      result.current.remove("contact-1");
    });
    expect([...result.current.ids]).toEqual(["contact-2"]);
  });

  test("a change replaces the set, so a memo reading it recomputes", () => {
    const { result } = renderHook(() => usePendingContactIds());
    const empty = result.current.ids;

    act(() => {
      result.current.add("contact-1");
    });
    const added = result.current.ids;
    expect(added).not.toBe(empty);

    act(() => {
      result.current.remove("contact-1");
    });
    expect(result.current.ids).not.toBe(added);
  });

  test("adding an id already held leaves the set alone", () => {
    const { result } = renderHook(() => usePendingContactIds());

    act(() => {
      result.current.add("contact-1");
    });
    const added = result.current.ids;

    act(() => {
      result.current.add("contact-1");
    });
    expect(result.current.ids).toBe(added);
    expect(result.current.ids.size).toBe(1);
  });

  test("removing an id it never held leaves the set alone", () => {
    const { result } = renderHook(() => usePendingContactIds());

    act(() => {
      result.current.add("contact-1");
    });
    const added = result.current.ids;

    act(() => {
      result.current.remove("contact-2");
    });
    expect(result.current.ids).toBe(added);
    expect([...result.current.ids]).toEqual(["contact-1"]);
  });

  test("keeps its callbacks across renders", () => {
    const { result, rerender } = renderHook(() => usePendingContactIds());
    const { add, remove } = result.current;

    act(() => {
      result.current.add("contact-1");
    });
    rerender();

    expect(result.current.add).toBe(add);
    expect(result.current.remove).toBe(remove);
  });
});
