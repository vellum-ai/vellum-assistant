import { beforeEach, describe, expect, mock, test } from "bun:test";

const componentLoad = mock(() => Promise.resolve({ Component: () => null }));
const rejectingLoad = mock(() => Promise.reject(new Error("chunk failed")));

mock.module("@/routes", () => ({
  routeTree: [
    {
      path: "/assistant",
      children: [
        { path: "library", lazy: { Component: componentLoad } },
        { path: "boom", lazy: { Component: rejectingLoad } },
      ],
    },
  ],
}));

const { prefetchRoute, resetPrefetchedRoutes } =
  await import("@/lib/prefetch-route");

/**
 * The helper never awaits. Its first call also resolves a dynamic import,
 * which needs a real task, not just a drained microtask queue.
 */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("prefetchRoute", () => {
  beforeEach(() => {
    resetPrefetchedRoutes();
    componentLoad.mockClear();
    rejectingLoad.mockClear();
  });

  test("requests the lazy chunk on the matching route branch", async () => {
    prefetchRoute("/assistant/library");
    await settle();
    expect(componentLoad).toHaveBeenCalledTimes(1);
  });

  test("requests each path only once", async () => {
    prefetchRoute("/assistant/library");
    await settle();
    prefetchRoute("/assistant/library");
    await settle();
    expect(componentLoad).toHaveBeenCalledTimes(1);
  });

  test("ignores an empty href", async () => {
    prefetchRoute(undefined);
    prefetchRoute("");
    await settle();
    expect(componentLoad).not.toHaveBeenCalled();
  });

  test("loads nothing for a path that matches no route", async () => {
    prefetchRoute("/assistant/nope");
    await settle();
    expect(componentLoad).not.toHaveBeenCalled();
  });

  test("swallows a failed chunk request", async () => {
    prefetchRoute("/assistant/boom");
    await settle();
    expect(rejectingLoad).toHaveBeenCalledTimes(1);
  });
});
