import { describe, expect, test } from "bun:test";

import type { SubagentParentNotification } from "../../subagent/parent-notification.js";
import { VoiceSubagentNotifications } from "../subagent-notifications.js";

function notification(
  subagentId: string,
  message: string,
): SubagentParentNotification {
  return { taskId: subagentId, message, metadata: {} };
}

describe("voice task delivery", () => {
  test("finishing one task's playback preserves other tasks and newer updates", () => {
    const queue = new VoiceSubagentNotifications();
    const blocked = notification("task-1", "Needs a decision");
    const other = notification("task-2", "Finished the comparison");
    const completed = notification("task-1", "Finished the export");
    queue.enqueue(blocked);
    queue.enqueue(other);
    queue.finish(blocked, 200);
    queue.enqueue(completed);

    queue.acknowledgePlayback(200);
    expect(queue.drain(200)).toEqual([completed, other]);
  });

  test("an interruption during playback retains the outcome for delivery", () => {
    const queue = new VoiceSubagentNotifications();
    const result = notification("task-1", "Finished");
    queue.enqueue(result);
    queue.finish(result, 200);
    queue.interruptPlayback(100);
    queue.acknowledgePlayback(300);
    expect(queue.next()).toBe(result);
  });

  test("hang-up returns unheard results once and excludes completed playback", () => {
    const queue = new VoiceSubagentNotifications();
    const heard = notification("task-1", "Finished");
    const unheard = notification("task-2", "Failed");
    queue.enqueue(heard);
    queue.enqueue(unheard);
    queue.finish(heard, 200);
    expect(queue.drain(201)).toEqual([unheard]);
    expect(queue.drain(201)).toEqual([]);
  });
});
