/**
 * Tests for the imperative transcript scroll utilities.
 *
 * `bun:test` runs without a real DOM, so we exercise `attachSnapToLatest`
 * — the pure imperative function the hook delegates to — against
 * a minimal fake element shape. The hook itself is thin glue around
 * this function; testing the function covers the load-bearing
 * behavior (initial snap, re-snap on content resize, gesture disengage).
 */

import { describe, expect, test } from "bun:test";

import { attachSnapToLatest } from "@/domains/chat/transcript/transcript-scroll";

type Listener = (...args: unknown[]) => void;

type FakeElement = {
  scrollTop: number;
  scrollHeight: number;
  addEventListener(event: string, listener: Listener): void;
  removeEventListener(event: string, listener: Listener): void;
  fire(event: string): void;
  listenerCount(event: string): number;
};

function createFakeElement(scrollHeight: number): FakeElement {
  const listeners = new Map<string, Set<Listener>>();
  return {
    scrollTop: 0,
    scrollHeight,
    addEventListener(event, listener) {
      let set = listeners.get(event);
      if (!set) {
        set = new Set();
        listeners.set(event, set);
      }
      set.add(listener);
    },
    removeEventListener(event, listener) {
      listeners.get(event)?.delete(listener);
    },
    fire(event) {
      listeners.get(event)?.forEach((l) => l());
    },
    listenerCount(event) {
      return listeners.get(event)?.size ?? 0;
    },
  };
}

class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  callback: ResizeObserverCallback;
  observed: Element[] = [];
  disconnected = false;
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    FakeResizeObserver.instances.push(this);
  }
  observe(el: Element): void {
    this.observed.push(el);
  }
  unobserve(): void {}
  disconnect(): void {
    this.disconnected = true;
  }
  fire(): void {
    this.callback([], this as unknown as ResizeObserver);
  }
}

function installFakeResizeObserver(): void {
  FakeResizeObserver.instances = [];
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver =
    FakeResizeObserver;
}

function uninstallFakeResizeObserver(): void {
  delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
}

describe("attachSnapToLatest", () => {
  test("snaps to bottom on initial attach", () => {
    installFakeResizeObserver();
    const container = createFakeElement(1000);
    const content = createFakeElement(1000);
    container.scrollTop = 0;

    const stop = attachSnapToLatest({
      container: container as unknown as HTMLElement,
      content: content as unknown as HTMLElement,
    });

    expect(container.scrollTop).toBe(1000);

    stop();
    uninstallFakeResizeObserver();
  });

  test("re-snaps on content ResizeObserver fire (covers seed-then-grow race)", () => {
    installFakeResizeObserver();
    const container = createFakeElement(500);
    const content = createFakeElement(500);

    attachSnapToLatest({
      container: container as unknown as HTMLElement,
      content: content as unknown as HTMLElement,
    });

    expect(container.scrollTop).toBe(500);

    // Simulate `useViewportMinHeight` seeding LatestTurnRow's minHeight:
    // content grows, scrollHeight grows.
    container.scrollHeight = 1500;
    FakeResizeObserver.instances[0].fire();

    expect(container.scrollTop).toBe(1500);

    uninstallFakeResizeObserver();
  });

  test("stops re-snapping after user wheel gesture", () => {
    installFakeResizeObserver();
    const container = createFakeElement(500);
    const content = createFakeElement(500);

    attachSnapToLatest({
      container: container as unknown as HTMLElement,
      content: content as unknown as HTMLElement,
    });

    // User scrolls up.
    container.scrollTop = 100;
    container.fire("wheel");

    // ResizeObserver fires after disengage — should NOT re-snap.
    container.scrollHeight = 1500;
    FakeResizeObserver.instances[0].fire();

    expect(container.scrollTop).toBe(100);
    expect(FakeResizeObserver.instances[0].disconnected).toBe(true);

    uninstallFakeResizeObserver();
  });

  test("stops re-snapping after touchmove and keydown gestures too", () => {
    installFakeResizeObserver();
    const container1 = createFakeElement(500);
    const content1 = createFakeElement(500);
    attachSnapToLatest({
      container: container1 as unknown as HTMLElement,
      content: content1 as unknown as HTMLElement,
    });
    container1.scrollTop = 100;
    container1.fire("touchmove");
    container1.scrollHeight = 1500;
    FakeResizeObserver.instances[0].fire();
    expect(container1.scrollTop).toBe(100);

    const container2 = createFakeElement(500);
    const content2 = createFakeElement(500);
    attachSnapToLatest({
      container: container2 as unknown as HTMLElement,
      content: content2 as unknown as HTMLElement,
    });
    container2.scrollTop = 100;
    container2.fire("keydown");
    container2.scrollHeight = 1500;
    FakeResizeObserver.instances[1].fire();
    expect(container2.scrollTop).toBe(100);

    uninstallFakeResizeObserver();
  });

  test("teardown removes listeners and disconnects observer", () => {
    installFakeResizeObserver();
    const container = createFakeElement(500);
    const content = createFakeElement(500);

    const stop = attachSnapToLatest({
      container: container as unknown as HTMLElement,
      content: content as unknown as HTMLElement,
    });

    expect(container.listenerCount("wheel")).toBe(1);
    expect(container.listenerCount("touchmove")).toBe(1);
    expect(container.listenerCount("keydown")).toBe(1);

    stop();

    expect(container.listenerCount("wheel")).toBe(0);
    expect(container.listenerCount("touchmove")).toBe(0);
    expect(container.listenerCount("keydown")).toBe(0);
    expect(FakeResizeObserver.instances[0].disconnected).toBe(true);

    uninstallFakeResizeObserver();
  });

  test("no ResizeObserver available — snaps once and returns inert teardown", () => {
    // SSR / older test environments.
    const container = createFakeElement(800);
    const content = createFakeElement(800);

    const stop = attachSnapToLatest({
      container: container as unknown as HTMLElement,
      content: content as unknown as HTMLElement,
    });

    expect(container.scrollTop).toBe(800);
    expect(container.listenerCount("wheel")).toBe(0);

    // Should not throw.
    stop();
  });
});
