import { describe, expect, test } from "bun:test";

import { createConversationTaskQueue } from "./conversation-queue.js";

describe("conversation task queue", () => {
  test("preserves ordering within a conversation", async () => {
    const queue = createConversationTaskQueue();
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstDone = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = queue.enqueue("conversation-1", async () => {
      events.push("first-start");
      await firstDone;
      events.push("first-end");
    });
    const second = queue.enqueue("conversation-1", async () => {
      events.push("second");
    });

    await Promise.resolve();
    expect(events).toEqual(["first-start"]);

    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual(["first-start", "first-end", "second"]);
  });

  test("does not serialize different conversations", async () => {
    const queue = createConversationTaskQueue();
    let releaseFirst!: () => void;
    const firstDone = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let secondFinished = false;

    const first = queue.enqueue("conversation-1", async () => {
      await firstDone;
    });
    const second = queue.enqueue("conversation-2", async () => {
      secondFinished = true;
    });

    await second;
    expect(secondFinished).toBe(true);

    releaseFirst();
    await first;
  });

  test("runs the next task after a rejection", async () => {
    const queue = createConversationTaskQueue();
    const second = queue.enqueue("conversation-1", async () => {
      throw new Error("first task failed");
    });
    await expect(second).rejects.toThrow("first task failed");

    await expect(
      queue.enqueue("conversation-1", async () => "second task completed"),
    ).resolves.toBe("second task completed");
  });
});
