import { describe, expect, test } from "bun:test";

import { createNotifier } from "@/lib/create-notifier";

describe("createNotifier", () => {
  test("runs every listener on notify and stops on unsubscribe", () => {
    const notifier = createNotifier();
    const seen: string[] = [];
    const unsubscribeFirst = notifier.subscribe(() => seen.push("first"));
    notifier.subscribe(() => seen.push("second"));

    notifier.notify();
    unsubscribeFirst();
    notifier.notify();

    expect(seen).toEqual(["first", "second", "second"]);
  });

  test("channels are independent", () => {
    const one = createNotifier();
    const two = createNotifier();
    let twoRuns = 0;
    two.subscribe(() => {
      twoRuns += 1;
    });

    one.notify();

    expect(twoRuns).toBe(0);
  });

  test("a throwing listener stops neither its peers nor the caller", () => {
    /**
     * Notifiers fire from inside a request path (an HTTP response
     * interceptor) that has to complete either way, and a listener
     * registered later must not depend on how an earlier one behaved.
     */
    const notifier = createNotifier();
    let laterRuns = 0;
    notifier.subscribe(() => {
      throw new Error("listener blew up");
    });
    notifier.subscribe(() => {
      laterRuns += 1;
    });

    expect(() => notifier.notify()).not.toThrow();
    expect(laterRuns).toBe(1);
  });
});
