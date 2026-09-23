import { afterEach, beforeEach, expect, mock, test } from "bun:test";

import { BrowserNotificationDelivery } from "@/runtime/browser-notification-delivery";
import { publish } from "@/lib/event-bus";

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

test("two pages share sound ownership separately from accepted banner receipts", async () => {
  const firstTab = new BrowserNotificationDelivery();
  const secondTab = new BrowserNotificationDelivery();
  const key = '["account-1","assistant-1","signal-1"]';
  expect(await Promise.all([firstTab.claimSound(key), secondTab.claimSound(key)]))
    .toEqual(["claimed", "duplicate"]);
  expect(localStorage.getItem("vellum:browser-notification-deliveries:v1")).toBeNull();
  expect(JSON.parse(localStorage.getItem("vellum:browser-notification-sounds:v1")!))
    .toHaveLength(1);
  expect(await secondTab.post(key, () => undefined)).toBe("posted");
  expect(await secondTab.claimSound(key)).toBe("duplicate");
  expect(await secondTab.claimSound('["account-2","assistant-1","signal-1"]')).toBe("claimed");
  expect(await secondTab.claimSound('["account-1","assistant-2","signal-1"]')).toBe("claimed");
});

test("cancelled and attended sound claims retain no ownership receipt", async () => {
  const tab = new BrowserNotificationDelivery();
  let sessionValid = true;
  const pending = tab.claimSound("signal-1", () => sessionValid);
  sessionValid = false;
  expect(await pending).toBe("cancelled");
  const stop = tab.trackAttention(() => "conversation-key");
  try {
    expect(await tab.claimSound("signal-2", undefined, "conversation-key")).toBe("suppressed");
    expect(localStorage.getItem("vellum:browser-notification-sounds:v1")).toBeNull();
  } finally {
    stop();
  }
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

test("attended conversation suppresses a hidden tab before either tab receives its intent", async () => {
  const focusedTab = new BrowserNotificationDelivery();
  const hiddenTab = new BrowserNotificationDelivery();
  let conversationKey: string | null = '["account-1","assistant-1","conversation-1"]';
  const stop = focusedTab.trackAttention(() => conversationKey);
  const post = mock(() => undefined);
  try {
    expect(await hiddenTab.post("signal-1", post, undefined, conversationKey)).toBe("suppressed");
    expect(await focusedTab.post("signal-1", post, undefined, conversationKey)).toBe("suppressed");
    expect(post).not.toHaveBeenCalled();
    expect(localStorage.getItem("vellum:browser-notification-deliveries:v1")).toBeNull();
    const previousKey = conversationKey;
    conversationKey = null;
    publish("app.attention", { attended: false });
    expect(await hiddenTab.post("signal-2", post, undefined, previousKey)).toBe("posted");
  } finally {
    stop();
  }
});

test("attention respects account, assistant, and conversation scope and cleanup", () => {
  const focusedTab = new BrowserNotificationDelivery();
  const hiddenTab = new BrowserNotificationDelivery();
  const key = '["account-1","assistant-1","conversation-1"]';
  const stop = focusedTab.trackAttention(() => key);
  expect(hiddenTab.isConversationAttended(key)).toBe(true);
  for (const otherKey of [
    '["account-2","assistant-1","conversation-1"]',
    '["account-1","assistant-2","conversation-1"]',
    '["account-1","assistant-1","conversation-2"]',
  ]) {
    expect(hiddenTab.isConversationAttended(otherKey)).toBe(false);
  }
  stop();
  expect(hiddenTab.isConversationAttended(key)).toBe(false);
});

test("expired, corrupt, and impossible future attention leases cannot suppress delivery", async () => {
  const prefix = "vellum:browser-notification-attention:v1:";
  const key = '["account-1","assistant-1","conversation-1"]';
  localStorage.setItem(`${prefix}expired`, JSON.stringify([key, Date.now() - 1]));
  localStorage.setItem(`${prefix}future`, JSON.stringify([key, Date.now() + 60_000]));
  localStorage.setItem(`${prefix}corrupt`, "{");
  const tab = new BrowserNotificationDelivery();
  expect(await tab.post("signal", () => undefined, undefined, key)).toBe("posted");
  expect(localStorage.getItem(`${prefix}expired`)).toBeNull();
  expect(localStorage.getItem(`${prefix}future`)).toBeNull();
  expect(localStorage.getItem(`${prefix}corrupt`)).toBeNull();
});
