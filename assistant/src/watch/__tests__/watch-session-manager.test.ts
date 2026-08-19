import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, jest, test } from "bun:test";

import { getConversation } from "../../persistence/conversation-crud.js";
import { initializeDb } from "../../persistence/db-init.js";
import type { HostObservation } from "../../runtime/host-observe.js";
import { WatchSessionManager } from "../watch-session-manager.js";
import { renderWatchTimeline } from "../watch-timeline.js";

await initializeDb();

const PRINCIPAL_ID = "principal-watch-test";

/** A 1x1 JPEG, the shape the host hands over on every observe. */
const SCREENSHOT_BASE64 =
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD3+iiigD//2Q==";

/** An ordinary observation: the accessibility tree carried the screen. */
function richObservation(): HostObservation {
  return {
    ok: true,
    axTree: "Window: Editor\n[1] Button Save",
    axDiff:
      'CHANGES SINCE LAST ACTION:\n~ Changed: [1] Save - value: "a" to "b"',
    screenshot: SCREENSHOT_BASE64,
  };
}

/** The shape the helper returns when accessibility found no focused window. */
function treelessObservation(): HostObservation {
  return { ok: true, screenshot: SCREENSHOT_BASE64 };
}

/** The sentinel `AXTreeDiff` writes when the window was replaced wholesale. */
function navigatedObservation(): HostObservation {
  return {
    ok: true,
    axTree: "Window: Browser\n[1] Link Home",
    axDiff:
      "CHANGES SINCE LAST ACTION:\nPage navigated - UI changed substantially (40 of 50 elements differ). Refer to the current screen state below.",
    screenshot: SCREENSHOT_BASE64,
  };
}

let nowMs = 1_000_000;

/**
 * A manager wired to a scripted screen reader and the test's own clock, so a
 * session's cadence is a function of the timeline the test writes rather than
 * of how long the test took to run.
 */
function newManager(
  respond: (call: number) => HostObservation = () => richObservation(),
) {
  const calls: number[] = [];
  const manager = new WatchSessionManager({
    now: () => nowMs,
    observe: async () => {
      calls.push(nowMs);
      return respond(calls.length);
    },
  });
  return { manager, calls };
}

/**
 * A manager whose screen reads hang until the test releases them, so how long
 * the host takes to answer is something the test states rather than waits for.
 */
function newDeferredManager() {
  const releases: ((observation: HostObservation) => void)[] = [];
  const manager = new WatchSessionManager({
    now: () => nowMs,
    observe: () =>
      new Promise<HostObservation>((resolve) => {
        releases.push(resolve);
      }),
  });
  return { manager, releases };
}

function start(manager: WatchSessionManager) {
  const result = manager.start({ sourceActorPrincipalId: PRINCIPAL_ID });
  if (result.status !== "started") {
    throw new Error(`Expected a started session, got ${result.status}`);
  }
  return result;
}

/**
 * Let every already-resolved promise in an observation's chain settle. Fake
 * timers stop the clock but not the microtask queue, so the work an expired
 * timer kicks off lands here.
 */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    await Promise.resolve();
  }
}

/** Advance the session's clock and the timers armed against it together. */
async function elapse(ms: number): Promise<void> {
  nowMs += ms;
  jest.advanceTimersByTime(ms);
  await settle();
}

beforeEach(() => {
  jest.useFakeTimers();
  nowMs = 1_000_000;
});

describe("watch session manager", () => {
  test("runs in a background conversation so the thread stays out of the sidebar", () => {
    const { manager } = newManager();
    const started = start(manager);

    expect(getConversation(started.conversationId)?.conversationType).toBe(
      "background",
    );
    expect(manager.isActive()).toBe(true);
    expect(manager.isActive(started.conversationId)).toBe(true);
    expect(manager.isActive(randomUUID())).toBe(false);

    manager.stop();
  });

  test("refuses a second session while one is running", () => {
    const { manager } = newManager();
    const started = start(manager);

    const second = manager.start({ sourceActorPrincipalId: PRINCIPAL_ID });
    expect(second).toEqual({
      status: "busy",
      sessionId: started.sessionId,
      conversationId: started.conversationId,
    });

    manager.stop();
    expect(manager.start({ sourceActorPrincipalId: PRINCIPAL_ID }).status).toBe(
      "started",
    );
    manager.stop();
  });

  test("fails closed without an actor principal to observe for", () => {
    const { manager, calls } = newManager();

    const result = manager.start({
      sourceActorPrincipalId: undefined as unknown as string,
    });

    expect(result.status).toBe("failed");
    expect(manager.isActive()).toBe(false);
    expect(calls).toHaveLength(0);
  });

  test("refuses a conversation id whose row does not exist", () => {
    const { manager } = newManager();

    const result = manager.start({
      sourceActorPrincipalId: PRINCIPAL_ID,
      conversationId: randomUUID(),
    });

    expect(result.status).toBe("failed");
    expect(manager.isActive()).toBe(false);
  });

  test("collapses a burst of narration finals into one observation", async () => {
    const { manager, calls } = newManager();
    start(manager);

    for (let i = 0; i < 5; i += 1) {
      await manager.handleNarrationFinal(`burst ${i}`);
      await elapse(400);
    }

    expect(calls).toHaveLength(1);

    // The gap reopens once the minimum interval has passed.
    await elapse(4_000);
    await manager.handleNarrationFinal("after the floor");
    expect(calls).toHaveLength(2);

    manager.stop();
  });

  test("observes four times across a 60s session of ten narration finals", async () => {
    const { manager, calls } = newManager();
    const started = start(manager);

    // Three clusters of three finals plus a closing one, the shape of someone
    // describing a step, working through it, then describing the next.
    const finalsAtMs = [
      0, 500, 1_000, 20_000, 20_500, 21_000, 40_000, 40_500, 41_000, 59_000,
    ];
    let elapsedMs = 0;
    for (const atMs of finalsAtMs) {
      await elapse(atMs - elapsedMs);
      elapsedMs = atMs;
      await manager.handleNarrationFinal(`step at ${atMs}`);
    }

    expect(calls).toHaveLength(4);

    const summary = manager.stop();
    expect(summary).not.toBeNull();
    expect(summary?.sessionId).toBe(started.sessionId);
    expect(summary?.conversationId).toBe(started.conversationId);
    expect(summary?.entryCount).toBe(finalsAtMs.length + calls.length);
    expect(summary?.durationMs).toBe(59_000);
  });

  test("keeps observing through a silent stretch of work", async () => {
    const { manager, calls } = newManager();
    const started = start(manager);

    // Not a word spoken for a minute and a half.
    await elapse(30_000);
    expect(calls).toHaveLength(1);
    await elapse(30_000);
    expect(calls).toHaveLength(2);
    await elapse(30_000);
    expect(calls).toHaveLength(3);

    const rendered = renderWatchTimeline(started.sessionId);
    expect(rendered.totalEntries).toBe(3);

    manager.stop();
  });

  test("survives repeated observation failures and still hands back a handle", async () => {
    const { manager, calls } = newManager((call) =>
      call <= 3
        ? {
            ok: false,
            reason: "No connected client supports screen observation",
          }
        : richObservation(),
    );
    const started = start(manager);

    for (let i = 0; i < 4; i += 1) {
      await manager.handleNarrationFinal(`narration ${i}`);
      await elapse(6_000);
    }

    expect(calls).toHaveLength(4);
    const summary = manager.stop();
    // Four narrations landed; only the fourth observation had anything to file.
    expect(summary?.entryCount).toBe(5);
    expect(renderWatchTimeline(started.sessionId).totalEntries).toBe(5);
  });

  test("stop is idempotent and ends the cadence", async () => {
    const { manager, calls } = newManager();
    start(manager);

    await manager.handleNarrationFinal("something worth watching");
    expect(calls).toHaveLength(1);

    const first = manager.stop();
    expect(first).not.toBeNull();
    expect(manager.stop()).toBeNull();
    expect(manager.isActive()).toBe(false);
    expect(manager.activeSessionId).toBeNull();

    // Neither narration nor the idle ceiling reaches a stopped session.
    await manager.handleNarrationFinal("nobody is listening");
    await elapse(90_000);
    expect(calls).toHaveLength(1);
  });

  test("never runs two observations at once, and drops one that lands after the session ended", async () => {
    const { manager, releases } = newDeferredManager();
    const started = start(manager);

    const first = manager.handleNarrationFinal("mid-observation");
    await settle();
    expect(releases).toHaveLength(1);

    // The floor has passed but the first read has not come back, so this final
    // records what was said and waits rather than stacking a second request.
    await elapse(6_000);
    const second = manager.handleNarrationFinal("still talking");
    await settle();
    expect(releases).toHaveLength(1);

    const summary = manager.stop();
    expect(summary?.entryCount).toBe(2);

    for (const release of releases) {
      release(richObservation());
    }
    await Promise.all([first, second]);
    await settle();

    expect(renderWatchTimeline(started.sessionId).totalEntries).toBe(2);
  });

  test("a slow read spends the interval it belongs to rather than extending it", async () => {
    const { manager, releases } = newDeferredManager();
    start(manager);

    // Silence, so the ceiling is what dispatches the read.
    await elapse(30_000);
    expect(releases).toHaveLength(1);

    // The host takes 8s to answer, most of the 10s the session allows it.
    await elapse(8_000);
    releases[0](richObservation());
    await settle();

    // The next read is due 30s after the one that went out, so 22s from here.
    // A fresh interval measured from the answer would put it 8s later.
    await elapse(21_999);
    expect(releases).toHaveLength(1);
    await elapse(1);
    expect(releases).toHaveLength(2);

    manager.stop();
  });

  test("a ceiling tick that lands mid-read is deferred, not dropped", async () => {
    const { manager, releases } = newDeferredManager();
    start(manager);

    const narration = manager.handleNarrationFinal("starting the long one");
    await settle();
    expect(releases).toHaveLength(1);

    // The ceiling comes due while that read is still out. It stacks no second
    // request, and the deadline it belongs to is already spent.
    await elapse(30_000);
    expect(releases).toHaveLength(1);

    releases[0](richObservation());
    await narration;
    await settle();
    await elapse(1);
    expect(releases).toHaveLength(2);

    manager.stop();
  });

  describe("screenshot escalation", () => {
    async function observeOnce(respond: () => HostObservation) {
      const { manager } = newManager(respond);
      const started = start(manager);
      await manager.handleNarrationFinal("look at this");
      manager.stop();
      return renderWatchTimeline(started.sessionId);
    }

    test("keeps no frame when the accessibility tree carried the screen", async () => {
      const rendered = await observeOnce(richObservation);
      expect(rendered.totalEntries).toBe(2);
      expect(rendered.screenshotEntryIds).toHaveLength(0);
    });

    test("keeps a frame when the observation has no accessibility tree", async () => {
      const rendered = await observeOnce(treelessObservation);
      expect(rendered.screenshotEntryIds).toHaveLength(1);
    });

    test("keeps a frame when the diff reports a whole-window replacement", async () => {
      const rendered = await observeOnce(navigatedObservation);
      expect(rendered.screenshotEntryIds).toHaveLength(1);
    });
  });
});
