/**
 * Tests for `observeViewportRect`, the one owner of "what can move an element's
 * viewport rect".
 *
 * The contract under test is the *completeness* of the signal set, since that is
 * the whole reason the module exists and the thing that drifts when it does not.
 * Each signal gets its own assertion, so dropping any one fails a named test
 * rather than quietly leaving a subscription that still looks like it works.
 *
 * `visualViewport` is stubbed because happy-dom does not implement it; the stub
 * is a real `EventTarget` so the listeners under test are the ones dispatched
 * to. `ResizeObserver` exists in happy-dom but never fires, so it is replaced
 * with a recorder: "every target is observed, and the observer is disconnected
 * on teardown" is only visible from the observer's side.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { observeViewportRect } from "@/lib/observe-viewport-rect";

/** Targets an observer was asked to watch, newest instance last. */
let observed: Element[][] = [];
let disconnectCount = 0;

const NativeResizeObserver = globalThis.ResizeObserver;

class RecordingResizeObserver {
  private readonly targets: Element[] = [];

  constructor() {
    observed.push(this.targets);
  }

  observe(target: Element): void {
    this.targets.push(target);
  }

  disconnect(): void {
    disconnectCount += 1;
  }
}

function stubVisualViewport(): EventTarget {
  const viewport = new EventTarget();
  Object.defineProperty(window, "visualViewport", {
    configurable: true,
    value: viewport,
  });
  return viewport;
}

let visualViewport: EventTarget;
/** Subscriptions a test did not tear down itself, released after it. */
let openSubscriptions: (() => void)[] = [];

beforeEach(() => {
  observed = [];
  disconnectCount = 0;
  openSubscriptions = [];
  globalThis.ResizeObserver =
    RecordingResizeObserver as unknown as typeof ResizeObserver;
  visualViewport = stubVisualViewport();
});

afterEach(() => {
  for (const stop of openSubscriptions) {
    stop();
  }
  globalThis.ResizeObserver = NativeResizeObserver;
  Object.defineProperty(window, "visualViewport", {
    configurable: true,
    value: undefined,
  });
});

function element(): HTMLElement {
  return document.createElement("div");
}

/**
 * Subscribe, registering the teardown so a `window` listener never outlives the
 * test that made it. Tests asserting on teardown call the returned stop early;
 * releasing twice is harmless.
 */
function observe(
  targets: Parameters<typeof observeViewportRect>[0],
  onChange: () => void,
): () => void {
  const stop = observeViewportRect(targets, onChange);
  openSubscriptions.push(stop);
  return stop;
}

describe("observeViewportRect", () => {
  test("does not measure on subscribe: the caller owns the first read", () => {
    const onChange = mock(() => {});
    observe(element(), onChange);
    expect(onChange).not.toHaveBeenCalled();
  });

  test("fires on a window resize", () => {
    const onChange = mock(() => {});
    observe(element(), onChange);

    window.dispatchEvent(new Event("resize"));

    expect(onChange).toHaveBeenCalledTimes(1);
  });

  test("fires on a visualViewport resize", () => {
    const onChange = mock(() => {});
    observe(element(), onChange);

    visualViewport.dispatchEvent(new Event("resize"));

    expect(onChange).toHaveBeenCalledTimes(1);
  });

  test("fires on a visualViewport scroll", () => {
    const onChange = mock(() => {});
    observe(element(), onChange);

    // The signal iOS delivers on its own: the shell shifts by `offsetTop` with
    // no resize beside it, so a subscription without this one goes stale silently.
    visualViewport.dispatchEvent(new Event("scroll"));

    expect(onChange).toHaveBeenCalledTimes(1);
  });

  test("observes every target it was given", () => {
    const first = element();
    const second = element();

    observe([first, second], () => {});

    expect(observed).toHaveLength(1);
    expect(observed[0]).toEqual([first, second]);
  });

  test("skips nullish targets instead of throwing", () => {
    const present = element();
    const onChange = mock(() => {});

    observe([null, present, undefined], onChange);

    expect(observed[0]).toEqual([present]);
    // The window-level signals still apply: a caller measuring one element that
    // is there and one that is not still needs to hear about the viewport.
    window.dispatchEvent(new Event("resize"));
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  test("registers the window-level listeners once, not once per target", () => {
    const onChange = mock(() => {});
    observe([element(), element(), element()], onChange);

    window.dispatchEvent(new Event("resize"));
    visualViewport.dispatchEvent(new Event("scroll"));

    // Three targets, two events: a per-target registration would report six.
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  test("teardown releases every signal", () => {
    const onChange = mock(() => {});
    const stop = observe(element(), onChange);

    stop();

    window.dispatchEvent(new Event("resize"));
    visualViewport.dispatchEvent(new Event("resize"));
    visualViewport.dispatchEvent(new Event("scroll"));

    expect(onChange).not.toHaveBeenCalled();
    expect(disconnectCount).toBe(1);
  });

  test("survives a runtime with no visualViewport", () => {
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      value: undefined,
    });
    const onChange = mock(() => {});

    const stop = observe(element(), onChange);
    window.dispatchEvent(new Event("resize"));
    stop();

    expect(onChange).toHaveBeenCalledTimes(1);
  });
});
