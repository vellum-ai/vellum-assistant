import { afterEach, beforeEach, expect, mock, test } from "bun:test";

import { BrowserNotificationDelivery } from "@/runtime/browser-notification-delivery";

const originalLocks = Object.getOwnPropertyDescriptor(navigator, "locks");
let queue: Promise<unknown>;

beforeEach(() => {
  localStorage.clear();
  queue = Promise.resolve();
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: {
      request: (_name: string, callback: () => unknown) => {
        const result = queue.then(callback);
        queue = result.catch(() => undefined);
        return result;
      },
    },
  });
});

afterEach(() => {
  if (originalLocks) {
    Object.defineProperty(navigator, "locks", originalLocks);
  } else {
    Reflect.deleteProperty(navigator, "locks");
  }
  localStorage.clear();
});

test("two independent pages post once for the same scoped signal", async () => {
  const firstTab = new BrowserNotificationDelivery();
  const secondTab = new BrowserNotificationDelivery();
  const post = mock(() => undefined);
  const results = await Promise.all([
    firstTab.post('["account-1","assistant-1","signal-1"]', post),
    secondTab.post('["account-1","assistant-1","signal-1"]', post),
  ]);
  expect(results).toEqual(["posted", "duplicate"]);
  expect(post).toHaveBeenCalledTimes(1);
  expect(await secondTab.post('["account-2","assistant-1","signal-1"]', post)).toBe("posted");
  expect(await secondTab.post('["account-1","assistant-2","signal-1"]', post)).toBe("posted");
});

test("a failed post releases its claim for another tab", async () => {
  const firstTab = new BrowserNotificationDelivery();
  const secondTab = new BrowserNotificationDelivery();
  const first = firstTab.post("signal-1", () => { throw new Error("Browser refused"); });
  const second = secondTab.post("signal-1", () => undefined);
  await expect(first).rejects.toThrow("Browser refused");
  expect(await second).toBe("posted");
});

test("a queued delivery checks session ownership before posting", async () => {
  const tab = new BrowserNotificationDelivery();
  const post = mock(() => undefined);
  let currentSession = true;
  const delivery = tab.post("signal-1", post, () => currentSession);
  currentSession = false;
  expect(await delivery).toBe("cancelled");
  expect(post).not.toHaveBeenCalled();
});

test("receipts expire and are bounded", async () => {
  const tab = new BrowserNotificationDelivery();
  for (let i = 0; i < 150; i++) {
    await tab.post(`signal-${i}`, () => undefined);
  }
  const receipts = JSON.parse(localStorage.getItem("vellum:browser-notification-deliveries:v1")!);
  expect(receipts).toHaveLength(128);
  localStorage.setItem("vellum:browser-notification-deliveries:v1", JSON.stringify([["expired", Date.now() - 1]]));
  expect(await new BrowserNotificationDelivery().post("expired", () => undefined)).toBe("posted");
});

test("a rejected Web Locks request preserves delivery without retrying a failed post", async () => {
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: { request: () => Promise.reject(new DOMException("Blocked", "SecurityError")) },
  });
  const tab = new BrowserNotificationDelivery();
  const post = mock(() => undefined);
  expect(await tab.post("fallback", post)).toBe("posted");
  expect(await tab.post("fallback", post)).toBe("duplicate");
  expect(post).toHaveBeenCalledTimes(1);
});

test("delivery remains available when Web Locks is absent", async () => {
  Object.defineProperty(navigator, "locks", { configurable: true, value: undefined });
  const tab = new BrowserNotificationDelivery();
  const post = mock(() => undefined);
  expect(await tab.post("fallback", post)).toBe("posted");
  expect(await tab.post("fallback", post)).toBe("duplicate");
  expect(post).toHaveBeenCalledTimes(1);
});
