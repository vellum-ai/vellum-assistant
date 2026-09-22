/**
 * Paging past a window that holds no match.
 *
 * The chips and the search narrow the rows already loaded, while the read
 * behind them is one global recency page, so an empty view says nothing about
 * the pages behind it. The page has to keep asking until something stands or
 * the history runs out.
 *
 * An `IntersectionObserver` cannot drive that, which is the regression these
 * pin: a sentinel in an empty view never leaves the viewport, so it reports
 * one intersection and never another however many rows arrive, and exactly
 * one extra page would load.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, renderHook } from "@testing-library/react";

import { useBackfillUntilMatch } from "@/domains/chat/pages/old-chats-page";

afterEach(cleanup);

function setup(initial: { enabled: boolean; loadedCount: number }) {
  const calls: number[] = [];
  const onLoadMore = () => calls.push(calls.length);
  const view = renderHook(
    (props: { enabled: boolean; loadedCount: number }) =>
      useBackfillUntilMatch({ ...props, onLoadMore }),
    { initialProps: initial },
  );
  return { calls, view };
}

describe("useBackfillUntilMatch", () => {
  test("asks for a page as soon as the window leaves nothing standing", () => {
    const { calls } = setup({ enabled: true, loadedCount: 50 });
    expect(calls).toHaveLength(1);
  });

  test("asks again every time the window grows and still holds no match", () => {
    const { calls, view } = setup({ enabled: true, loadedCount: 50 });
    view.rerender({ enabled: true, loadedCount: 100 });
    view.rerender({ enabled: true, loadedCount: 150 });
    expect(calls).toHaveLength(3);
  });

  test("stops once a match appears", () => {
    const { calls, view } = setup({ enabled: true, loadedCount: 50 });
    view.rerender({ enabled: false, loadedCount: 100 });
    view.rerender({ enabled: false, loadedCount: 150 });
    expect(calls).toHaveLength(1);
  });

  test("never asks while the view already has rows", () => {
    const { calls, view } = setup({ enabled: false, loadedCount: 50 });
    view.rerender({ enabled: false, loadedCount: 100 });
    expect(calls).toHaveLength(0);
  });

  // The guard against a page that answers with nothing new: without a growing
  // count there is no reason to believe another request would differ.
  test("does not ask twice for the same window", () => {
    const { calls, view } = setup({ enabled: true, loadedCount: 50 });
    view.rerender({ enabled: true, loadedCount: 50 });
    view.rerender({ enabled: true, loadedCount: 50 });
    expect(calls).toHaveLength(1);
  });
});
