import { describe, expect, test } from "bun:test";

import { type VoiceTaskOutcome, VoiceTaskOutcomes } from "../task-outcomes.js";

function notification(subagentId: string, message: string): VoiceTaskOutcome {
  return { taskId: subagentId, message, metadata: {}, source: "subagent" };
}

describe("voice task delivery", () => {
  test("finishing one task's playback preserves other tasks and newer updates", () => {
    const queue = new VoiceTaskOutcomes();
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
    const queue = new VoiceTaskOutcomes();
    const result = notification("task-1", "Finished");
    queue.enqueue(result);
    queue.finish(result, 200);
    queue.interruptPlayback(100);
    queue.acknowledgePlayback(300);
    expect(queue.next()).toBe(result);
  });

  test("hang-up returns unheard results once and excludes completed playback", () => {
    const queue = new VoiceTaskOutcomes();
    const heard = notification("task-1", "Finished");
    const unheard = notification("task-2", "Failed");
    queue.enqueue(heard);
    queue.enqueue(unheard);
    queue.finish(heard, 200);
    expect(queue.drain(201)).toEqual([unheard]);
    expect(queue.drain(201)).toEqual([]);
  });
  test("reading a continuation as context never consumes it", () => {
    const queue = new VoiceTaskOutcomes();
    const result: VoiceTaskOutcome = {
      ...notification("continuation-1", "Report"),
      source: "continuation",
    };
    queue.enqueue(result);
    expect(queue.pendingOutcomes()).toEqual([result]);
    queue.finishContextReply([result], 200, "Birds have feathers.");
    queue.acknowledgePlayback(200);
    expect(queue.next()).toBe(result);
    expect(queue.deliveryContext(result)).toContain("Birds have feathers.");
  });

  test("a superseding completion retains the interrupted announcement state", () => {
    const queue = new VoiceTaskOutcomes();
    const progress = notification("task-1", "Initial findings");
    const completed = notification("task-1", "Full report");
    queue.enqueue(progress);
    queue.finish(progress, 200, "Generated explanation");
    queue.enqueue(completed);
    queue.interruptPlayback(100);
    expect(queue.next()).toBe(completed);
    expect(queue.deliveryContext(completed)).toContain(
      "interrupted before playback completed",
    );
    expect(queue.deliveryContext(completed)).not.toContain(
      "Generated explanation",
    );
  });

  test("an interruption before generation completes is retained across updates", () => {
    const queue = new VoiceTaskOutcomes();
    const progress = notification("task-1", "Initial findings");
    queue.enqueue(progress);
    queue.interrupt(progress);
    const completed = notification("task-1", "Full report");
    queue.enqueue(completed);
    expect(queue.deliveryContext(completed)).toContain(
      "interrupted before playback completed",
    );
  });

  test("a later update can distinguish completed playback from generated history", () => {
    const queue = new VoiceTaskOutcomes();
    const progress = notification("task-1", "Initial findings");
    queue.enqueue(progress);
    queue.finish(progress, 200, "The export requires a connection.");
    queue.acknowledgePlayback(200);
    expect(queue.hasPending).toBe(false);
    const completed = notification("task-1", "Full report");
    queue.enqueue(completed);
    expect(queue.deliveryContext(completed)).toContain(
      "The export requires a connection.",
    );
    expect(queue.deliveryContext(completed)).not.toContain("was interrupted");
  });

  test("a cut-off context reply provides no completed playback receipt", () => {
    const queue = new VoiceTaskOutcomes();
    const result = notification("task-1", "Report");
    queue.enqueue(result);
    queue.finishContextReply([result], 200, "Generated explanation");
    queue.interruptPlayback(100);
    queue.acknowledgePlayback(300);
    expect(queue.next()).toBe(result);
    expect(queue.deliveryContext(result)).not.toContain(
      "Generated explanation",
    );
    expect(queue.deliveryContext(result)).toContain(
      "no completed audio playback receipt",
    );
  });
});
