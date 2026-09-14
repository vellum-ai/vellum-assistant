import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import {
  __resetNotificationTapsForTests,
  dispatchNotificationTap,
  registerNotificationTapHandler,
  type NotificationTapPayload,
} from "@/runtime/notification-taps";

function tap(conversationId: string): NotificationTapPayload {
  return { conversationId, sourceEventName: "reminder.fired" };
}

async function flushTapQueue(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  __resetNotificationTapsForTests();
});

afterEach(() => {
  __resetNotificationTapsForTests();
});

describe("notification tap dispatcher", () => {
  test("delivers a tap to the current handler", async () => {
    const handler = mock((_payload: NotificationTapPayload) => undefined);
    registerNotificationTapHandler(handler);

    dispatchNotificationTap(tap("conv-1"));
    await flushTapQueue();

    expect(handler).toHaveBeenCalledWith(tap("conv-1"));
  });

  test("queues a cold-start arrival until handler registration", async () => {
    const handler = mock((_payload: NotificationTapPayload) => undefined);

    dispatchNotificationTap(tap("conv-cold"));
    expect(handler).not.toHaveBeenCalled();

    registerNotificationTapHandler(handler);
    await flushTapQueue();

    expect(handler).toHaveBeenCalledWith(tap("conv-cold"));
  });

  test("bounds queued taps and retains the newest arrivals", async () => {
    const received: string[] = [];
    let finishDrain = () => {};
    const drained = new Promise<void>((resolve) => {
      finishDrain = resolve;
    });
    for (let index = 0; index < 40; index += 1) {
      dispatchNotificationTap(tap(`conv-${index}`));
    }

    registerNotificationTapHandler((payload) => {
      if (payload.conversationId) {
        received.push(payload.conversationId);
        if (payload.conversationId === "conv-39") {
          finishDrain();
        }
      }
    });
    await drained;

    expect(received).toHaveLength(32);
    expect(received[0]).toBe("conv-8");
    expect(received.at(-1)).toBe("conv-39");
  });

  test("serializes taps while an asynchronous handler is busy", async () => {
    let releaseFirst = () => {};
    const firstPending = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const received: string[] = [];
    registerNotificationTapHandler(async (payload) => {
      if (payload.conversationId) {
        received.push(payload.conversationId);
      }
      if (payload.conversationId === "conv-1") {
        await firstPending;
      }
    });

    dispatchNotificationTap(tap("conv-1"));
    dispatchNotificationTap(tap("conv-2"));
    await flushTapQueue();
    expect(received).toEqual(["conv-1"]);

    releaseFirst();
    await flushTapQueue();
    expect(received).toEqual(["conv-1", "conv-2"]);
  });
});
