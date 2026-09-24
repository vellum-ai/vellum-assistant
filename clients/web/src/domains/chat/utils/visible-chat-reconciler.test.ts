import { expect, test } from "bun:test";

import { createVisibleChatReconciler } from "./visible-chat-reconciler";

function setup() {
  const requests: {
    id: string;
    isCurrent: () => boolean;
    resolve: () => void;
  }[] = [];
  const queue = createVisibleChatReconciler(
    (id, isCurrent) =>
      new Promise<void>((resolve) => {
        requests.push({ id, isCurrent, resolve });
      }),
    { concurrency: 2, now: () => 100 },
  );
  queue.start();
  return { queue, requests };
}

async function settle(request: { resolve: () => void }) {
  request.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

test("bounds concurrency, deduplicates rows, and skips rows that leave the viewport", async () => {
  const { queue, requests } = setup();
  queue.register("conv-1");
  queue.register("conv-1");
  queue.register("conv-2");
  const leave = queue.register("conv-3");
  queue.register("conv-4");
  expect(requests.map((r) => r.id)).toEqual(["conv-1", "conv-2"]);
  leave();
  await settle(requests[0]);
  expect(requests.map((r) => r.id)).toEqual(["conv-1", "conv-2", "conv-4"]);
  queue.stop();
});

test("reuses a fresh snapshot after a row remount", async () => {
  const { queue, requests } = setup();
  const leave = queue.register("conv-1");
  await settle(requests[0]);
  leave();
  queue.register("conv-1");
  expect(requests).toHaveLength(1);
  queue.stop();
});

test("a lifecycle event during a fetch causes one follow-up for its owner", async () => {
  const { queue, requests } = setup();
  queue.register("conv-1");
  queue.register("conv-2");
  queue.refresh("conv-1");
  queue.refresh("conv-1");
  await settle(requests[0]);
  await settle(requests[1]);
  expect(requests.map((r) => r.id)).toEqual(["conv-1", "conv-2", "conv-1"]);
  queue.stop();
});

test("reconnect refreshes only mounted rows", async () => {
  const { queue, requests } = setup();
  const leave = queue.register("conv-1");
  queue.register("conv-2");
  await settle(requests[0]);
  await settle(requests[1]);
  leave();
  queue.refresh();
  expect(requests.map((r) => r.id)).toEqual(["conv-1", "conv-2", "conv-2"]);
  queue.stop();
});

test("disposal invalidates responses and stops queued requests", async () => {
  const { queue, requests } = setup();
  queue.register("conv-1");
  queue.register("conv-2");
  queue.register("conv-3");
  queue.stop();
  expect(requests.every((r) => !r.isCurrent())).toBe(true);
  await settle(requests[0]);
  expect(requests).toHaveLength(2);
});

test("rows registered before readiness are retained when the queue starts", async () => {
  const { queue, requests } = setup();
  queue.stop();
  queue.register("conv-1");
  expect(requests).toHaveLength(0);
  queue.start();
  expect(requests).toHaveLength(1);
  queue.stop();
  queue.start();
  expect(requests[0].isCurrent()).toBe(false);
  await settle(requests[0]);
  expect(requests).toHaveLength(2);
  queue.stop();
});
