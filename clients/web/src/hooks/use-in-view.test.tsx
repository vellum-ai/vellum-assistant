/**
 * `useInView` reports the live intersection state rather than a latch: it turns
 * true as the element arrives, false as it leaves, and false again the moment
 * the observation ends, so a caller holding a resource while its element is on
 * screen releases it when the element goes away.
 *
 * Driven through a stub `IntersectionObserver`, since happy-dom implements
 * neither the API nor the layout that would drive it.
 */

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { RefObject } from "react";

import { useInView } from "@/hooks/use-in-view";

interface ObserverRecord {
  callback: IntersectionObserverCallback;
  observed: Element[];
  disconnects: number;
}

let observers: ObserverRecord[] = [];

class StubIntersectionObserver {
  private readonly record: ObserverRecord;

  constructor(callback: IntersectionObserverCallback) {
    this.record = { callback, observed: [], disconnects: 0 };
    observers.push(this.record);
  }

  observe(target: Element): void {
    this.record.observed.push(target);
  }

  unobserve(): void {}

  disconnect(): void {
    this.record.disconnects += 1;
  }

  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
}

const realIntersectionObserver = globalThis.IntersectionObserver;

function report(index: number, isIntersecting: boolean): void {
  const record = observers[index]!;
  act(() => {
    record.callback(
      [{ isIntersecting } as IntersectionObserverEntry],
      {} as IntersectionObserver,
    );
  });
}

function elementRef(): RefObject<Element | null> {
  return { current: document.createElement("div") };
}

function renderInView(ref: RefObject<Element | null> = elementRef()) {
  return renderHook(
    ({ target }: { target: RefObject<Element | null> }) => useInView(target),
    { initialProps: { target: ref } },
  );
}

beforeEach(() => {
  observers = [];
  globalThis.IntersectionObserver =
    StubIntersectionObserver as unknown as typeof IntersectionObserver;
});

afterEach(() => {
  cleanup();
});

afterAll(() => {
  globalThis.IntersectionObserver = realIntersectionObserver;
});

describe("useInView", () => {
  test("observes the element it was handed", () => {
    renderInView();

    expect(observers).toHaveLength(1);
    expect(observers[0]!.observed).toHaveLength(1);
  });

  test("turns true when the element arrives and false when it leaves", () => {
    const { result } = renderInView();

    expect(result.current).toBe(false);

    report(0, true);
    expect(result.current).toBe(true);

    report(0, false);
    expect(result.current).toBe(false);
  });

  test("forgets its last answer when the observation ends", () => {
    const { result, rerender } = renderInView();
    report(0, true);
    expect(result.current).toBe(true);

    // A new element tears the observer down and builds another, which is the
    // same cleanup an unmount runs.
    rerender({ target: elementRef() });

    expect(observers[0]!.disconnects).toBe(1);
    expect(observers).toHaveLength(2);
    expect(result.current).toBe(false);
  });

  test("disconnects on unmount", () => {
    const { unmount } = renderInView();
    report(0, true);

    unmount();

    expect(observers[0]!.disconnects).toBe(1);
  });

  test("stays false, and observes nothing, without IntersectionObserver", () => {
    // A caller that must draw regardless (the Chat Info tile's picture is its
    // content) reads `typeof IntersectionObserver` itself rather than waiting
    // on an answer this hook can never give.
    delete (globalThis as { IntersectionObserver?: unknown })
      .IntersectionObserver;

    const { result } = renderInView();

    expect(result.current).toBe(false);
    expect(observers).toHaveLength(0);
  });
});
