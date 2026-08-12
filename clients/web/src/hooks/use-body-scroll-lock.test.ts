/**
 * Tests for `useBodyScrollLock`, the body scroll lock every self-rendered
 * overlay holds while it is open.
 *
 * The contract worth protecting is the overlapping case. An overlay that
 * saves `document.body.style.overflow` for itself records `hidden` whenever
 * it opens over another overlay, and the order-independence tests below
 * reject exactly that shape: the release-inner-first test catches the page
 * scrolling while an overlay is still up, and the release-outer-first test
 * catches the body left permanently unscrollable.
 *
 * The pre-existing-value test is what makes those two meaningful rather than
 * vacuous: with `overflow` restored to a hardcoded `""` instead of the value
 * actually recorded, both order tests still pass and this one does not.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, renderHook } from "@testing-library/react";

import { useBodyScrollLock } from "@/hooks/use-body-scroll-lock";

beforeEach(() => {
  document.body.style.overflow = "";
});

afterEach(() => {
  cleanup();
  document.body.style.overflow = "";
});

describe("useBodyScrollLock", () => {
  test("hides overflow while held and restores it on unmount", () => {
    const held = renderHook(() => useBodyScrollLock());
    expect(document.body.style.overflow).toBe("hidden");

    held.unmount();
    expect(document.body.style.overflow).toBe("");
  });

  test("does not touch the body when disabled", () => {
    renderHook(() => useBodyScrollLock(false));
    expect(document.body.style.overflow).toBe("");
  });

  test("follows `enabled` as an overlay opens and closes", () => {
    const held = renderHook(
      ({ open }: { open: boolean }) => useBodyScrollLock(open),
      { initialProps: { open: false } },
    );
    expect(document.body.style.overflow).toBe("");

    held.rerender({ open: true });
    expect(document.body.style.overflow).toBe("hidden");

    held.rerender({ open: false });
    expect(document.body.style.overflow).toBe("");
  });

  test("keeps the lock while the inner of two overlays closes first", () => {
    const outer = renderHook(() => useBodyScrollLock());
    const inner = renderHook(() => useBodyScrollLock());

    inner.unmount();
    expect(document.body.style.overflow).toBe("hidden");

    outer.unmount();
    expect(document.body.style.overflow).toBe("");
  });

  test("keeps the lock while the outer of two overlays closes first", () => {
    const outer = renderHook(() => useBodyScrollLock());
    const inner = renderHook(() => useBodyScrollLock());

    outer.unmount();
    expect(document.body.style.overflow).toBe("hidden");

    inner.unmount();
    expect(document.body.style.overflow).toBe("");
  });

  test("restores the body's own overflow rather than a blank default", () => {
    document.body.style.overflow = "scroll";

    const outer = renderHook(() => useBodyScrollLock());
    const inner = renderHook(() => useBodyScrollLock());
    expect(document.body.style.overflow).toBe("hidden");

    inner.unmount();
    outer.unmount();
    expect(document.body.style.overflow).toBe("scroll");
  });
});
