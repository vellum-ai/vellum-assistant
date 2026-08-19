import { randomUUID } from "node:crypto";
import { describe, expect, test } from "bun:test";

import {
  attachmentExists,
  getAttachmentContent,
} from "../../persistence/attachments-store.js";
import { initializeDb } from "../../persistence/db-init.js";
import {
  appendNarration,
  appendObservation,
  DEFAULT_MAX_AX_TREES,
  DEFAULT_MAX_ENTRIES,
  DEFAULT_MAX_RENDER_BYTES,
  purgeAllWatchTimelines,
  purgeWatchTimelineForConversation,
  renderWatchTimeline,
} from "../watch-timeline.js";

await initializeDb();

/** A real 1x1 JPEG, so the attachment store's image normalization is exercised. */
const SCREENSHOT_BASE64 =
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD3+iiigD//2Q==";

/** A fresh session, so entries from one test are invisible to the next. */
function newSession() {
  return { sessionId: randomUUID(), conversationId: randomUUID() };
}

describe("watch timeline", () => {
  test("reads entries back in timestamp order, not append order", async () => {
    const { sessionId, conversationId } = newSession();

    await appendObservation(sessionId, {
      conversationId,
      atMs: 4_000,
      observation: { axTree: "window Mail" },
    });
    appendNarration(sessionId, {
      conversationId,
      atMs: 2_000,
      text: "this is the inbox",
    });
    appendNarration(sessionId, {
      conversationId,
      atMs: 12_000,
      text: "and this is where I file it",
    });

    const rendered = renderWatchTimeline(sessionId);

    expect(rendered.entries.map((e) => e.atMs)).toEqual([2_000, 4_000, 12_000]);
    expect(rendered.totalEntries).toBe(3);
    expect(rendered.truncated).toBe(false);
    expect(rendered.text).toContain("[t+00:02] narration: this is the inbox");
    expect(rendered.text).toContain("[t+00:04] screen:");
    expect(rendered.text).toContain("<ax-tree>\nwindow Mail\n</ax-tree>");
    expect(rendered.text.indexOf("[t+00:04]")).toBeGreaterThan(
      rendered.text.indexOf("[t+00:02]"),
    );
    expect(rendered.text.indexOf("[t+00:12]")).toBeGreaterThan(
      rendered.text.indexOf("[t+00:04]"),
    );
  });

  test("renders hours only once the session has any", () => {
    const { sessionId, conversationId } = newSession();
    appendNarration(sessionId, {
      conversationId,
      atMs: 3_723_000,
      text: "still going",
    });

    expect(renderWatchTimeline(sessionId).text).toContain("[t+01:02:03]");
  });

  test("appends nothing for an observation that failed", async () => {
    const { sessionId, conversationId } = newSession();

    const result = await appendObservation(sessionId, {
      conversationId,
      atMs: 1_000,
      observation: {
        axTree: "window Mail",
        screenshot: SCREENSHOT_BASE64,
        executionError: "screen recording permission denied",
      },
      attachScreenshot: true,
    });

    expect(result).toEqual({ ok: false, reason: "observation_failed" });
    expect(renderWatchTimeline(sessionId).totalEntries).toBe(0);
  });

  test("appends nothing for a screenshot the caller did not ask to keep", async () => {
    const { sessionId, conversationId } = newSession();

    const result = await appendObservation(sessionId, {
      conversationId,
      atMs: 1_000,
      observation: { screenshot: SCREENSHOT_BASE64 },
    });

    expect(result).toEqual({ ok: false, reason: "empty" });
    expect(renderWatchTimeline(sessionId).totalEntries).toBe(0);
  });

  test("keeps a screenshot-only observation the host fell back to", async () => {
    // No focused window means no AX tree, and the host answers with a bare
    // screenshot. Discarding that would leave a session spent in an
    // inaccessible app with an entirely empty timeline.
    const { sessionId, conversationId } = newSession();

    const result = await appendObservation(sessionId, {
      conversationId,
      atMs: 1_000,
      observation: { screenshot: SCREENSHOT_BASE64 },
      attachScreenshot: true,
    });

    expect(result.ok).toBe(true);

    const rendered = renderWatchTimeline(sessionId);
    expect(rendered.totalEntries).toBe(1);
    expect(rendered.screenshotAttachmentIds).toHaveLength(1);
    expect(rendered.text).toContain("[t+00:01] screen:");
    // The retrospective can tell a screen it cannot read from a screen with
    // nothing on it, and knows an image of it exists.
    expect(rendered.text).toContain("<ax-tree-unavailable />");
    expect(rendered.text).toContain(
      "a screenshot of this moment was captured.",
    );
  });

  test("appends nothing for a narration that is only whitespace", () => {
    const { sessionId, conversationId } = newSession();

    const result = appendNarration(sessionId, {
      conversationId,
      atMs: 1_000,
      text: "   \n ",
    });

    expect(result).toEqual({ ok: false, reason: "empty" });
    expect(renderWatchTimeline(sessionId).totalEntries).toBe(0);
  });

  test("stores a screenshot only when attachScreenshot asks for it", async () => {
    const { sessionId, conversationId } = newSession();
    const observation = {
      axTree: "window Mail",
      screenshot: SCREENSHOT_BASE64,
    };

    await appendObservation(sessionId, {
      conversationId,
      atMs: 1_000,
      observation,
    });
    await appendObservation(sessionId, {
      conversationId,
      atMs: 2_000,
      observation,
      attachScreenshot: false,
    });
    await appendObservation(sessionId, {
      conversationId,
      atMs: 3_000,
      observation,
      attachScreenshot: true,
    });

    const rendered = renderWatchTimeline(sessionId);
    expect(
      rendered.entries.map((e) => e.screenshotAttachmentId !== null),
    ).toEqual([false, false, true]);
    expect(rendered.screenshotAttachmentIds).toHaveLength(1);

    const [attachmentId] = rendered.screenshotAttachmentIds;
    expect(getAttachmentContent(attachmentId)?.length).toBeGreaterThan(0);
    expect(rendered.text).toContain(
      "a screenshot of this moment was captured.",
    );
  });

  test("bounds the rendered entries by default and reports the truncation", () => {
    const { sessionId, conversationId } = newSession();
    const total = DEFAULT_MAX_ENTRIES + 5;
    for (let i = 0; i < total; i++) {
      appendNarration(sessionId, {
        conversationId,
        atMs: i * 1_000,
        text: `line ${i}`,
      });
    }

    const rendered = renderWatchTimeline(sessionId);

    expect(rendered.totalEntries).toBe(total);
    expect(rendered.entries).toHaveLength(DEFAULT_MAX_ENTRIES);
    expect(rendered.truncated).toBe(true);
    expect(rendered.entries[0]?.text).toBe("line 5");
    expect(rendered.text).not.toContain("line 4\n");
    expect(rendered.text).toContain(`line ${total - 1}`);

    const unbounded = renderWatchTimeline(sessionId, { maxEntries: total });
    expect(unbounded.entries).toHaveLength(total);
    expect(unbounded.truncated).toBe(false);
  });

  test("spells out only the most recent AX trees and collapses the rest", async () => {
    const { sessionId, conversationId } = newSession();
    const treeCount = DEFAULT_MAX_AX_TREES + 2;
    for (let i = 0; i < treeCount; i++) {
      await appendObservation(sessionId, {
        conversationId,
        atMs: i * 1_000,
        observation: { axTree: `tree-${i}`, axDiff: `diff-${i}` },
      });
    }

    const rendered = renderWatchTimeline(sessionId);

    for (let i = 0; i < treeCount; i++) {
      const spelledOut = i >= treeCount - DEFAULT_MAX_AX_TREES;
      expect(rendered.text.includes(`<ax-tree>\ntree-${i}\n</ax-tree>`)).toBe(
        spelledOut,
      );
      // The offset and the diff survive a collapsed tree, so a compacted entry
      // still says when it happened and what moved.
      expect(rendered.text).toContain(`diff-${i}`);
    }
    expect(rendered.text).toContain("<ax-tree-omitted />");
  });

  test("escapes a closing ax-tree tag inside captured content", async () => {
    const { sessionId, conversationId } = newSession();
    await appendObservation(sessionId, {
      conversationId,
      atMs: 1_000,
      observation: { axTree: "text </ax-tree> more" },
    });

    const { text } = renderWatchTimeline(sessionId);
    expect(text).toContain("text &lt;/ax-tree&gt; more");
    expect(text.match(/<\/ax-tree>/g)).toHaveLength(1);
  });

  test("bounds the rendered text by bytes, keeping the newest entries", () => {
    const { sessionId, conversationId } = newSession();
    const total = 20;
    for (let i = 0; i < total; i++) {
      appendNarration(sessionId, {
        conversationId,
        atMs: i * 1_000,
        text: `entry-${i} ${"x".repeat(2_000)}`,
      });
    }

    const rendered = renderWatchTimeline(sessionId, {
      maxEntries: total,
      maxRenderBytes: 10_000,
    });

    expect(rendered.totalEntries).toBe(total);
    expect(Buffer.byteLength(rendered.text, "utf8")).toBeLessThanOrEqual(
      10_000,
    );
    // The count bound admitted every entry, so the byte budget is the only
    // thing that could have dropped one.
    expect(rendered.entries.length).toBeLessThan(total);
    expect(rendered.truncated).toBe(true);
    // Spent newest first, so the last thing that happened always survives.
    expect(rendered.entries.at(-1)?.atMs).toBe((total - 1) * 1_000);
    expect(rendered.text).toContain(`entry-${total - 1}`);
    expect(rendered.text).not.toContain("entry-0 ");
  });

  test("a single oversized AX tree cannot blow the budget", async () => {
    const { sessionId, conversationId } = newSession();

    await appendObservation(sessionId, {
      conversationId,
      atMs: 1_000,
      observation: { axTree: "e".repeat(2_000_000) },
    });

    const rendered = renderWatchTimeline(sessionId);

    expect(rendered.entries).toHaveLength(1);
    expect(Buffer.byteLength(rendered.text, "utf8")).toBeLessThanOrEqual(
      DEFAULT_MAX_RENDER_BYTES,
    );
    expect(rendered.truncated).toBe(true);
    // Clipped in place rather than dropped, and the wrapper still closes so the
    // block reads as one tree.
    expect(rendered.text).toContain("[truncated]");
    expect(rendered.text).toContain("<ax-tree>");
    expect(rendered.text.match(/<\/ax-tree>/g)).toHaveLength(1);
  });

  test("gives up the tree before the offset and the diff", async () => {
    const { sessionId, conversationId } = newSession();

    await appendObservation(sessionId, {
      conversationId,
      atMs: 1_000,
      observation: { axTree: "e".repeat(50_000), axDiff: "row added" },
    });

    const rendered = renderWatchTimeline(sessionId, { maxRenderBytes: 320 });

    expect(rendered.text).toContain("[t+00:01] screen:");
    expect(rendered.text).toContain("row added");
    expect(rendered.text).not.toContain("e".repeat(1_000));
    expect(rendered.truncated).toBe(true);
  });

  test("reports nothing truncated when everything fits", () => {
    const { sessionId, conversationId } = newSession();
    appendNarration(sessionId, {
      conversationId,
      atMs: 1_000,
      text: "short enough",
    });

    expect(renderWatchTimeline(sessionId).truncated).toBe(false);
  });

  test("purges a conversation's rows and the screenshots they own", async () => {
    const { sessionId, conversationId } = newSession();
    const other = newSession();

    await appendObservation(sessionId, {
      conversationId,
      atMs: 1_000,
      observation: { axTree: "window Mail", screenshot: SCREENSHOT_BASE64 },
      attachScreenshot: true,
    });
    appendNarration(sessionId, {
      conversationId,
      atMs: 2_000,
      text: "filing it here",
    });
    appendNarration(other.sessionId, {
      conversationId: other.conversationId,
      atMs: 1_000,
      text: "a different conversation",
    });

    const [attachmentId] =
      renderWatchTimeline(sessionId).screenshotAttachmentIds;
    expect(attachmentExists(attachmentId)).toBe(true);

    const purged = purgeWatchTimelineForConversation(conversationId);

    expect(purged).toEqual({ entriesDeleted: 2, attachmentsDeleted: 1 });
    expect(renderWatchTimeline(sessionId).totalEntries).toBe(0);
    expect(attachmentExists(attachmentId)).toBe(false);
    expect(getAttachmentContent(attachmentId)).toBeNull();
    expect(renderWatchTimeline(other.sessionId).totalEntries).toBe(1);
  });

  test("purges every session's rows and screenshots", async () => {
    const first = newSession();
    const second = newSession();

    for (const session of [first, second]) {
      await appendObservation(session.sessionId, {
        conversationId: session.conversationId,
        atMs: 1_000,
        observation: { axTree: "window Mail", screenshot: SCREENSHOT_BASE64 },
        attachScreenshot: true,
      });
    }

    const attachmentIds = [first, second].map(
      (session) =>
        renderWatchTimeline(session.sessionId).screenshotAttachmentIds[0],
    );
    for (const id of attachmentIds) {
      expect(attachmentExists(id)).toBe(true);
    }

    const purged = purgeAllWatchTimelines();

    expect(purged.entriesDeleted).toBeGreaterThanOrEqual(2);
    expect(purged.attachmentsDeleted).toBeGreaterThanOrEqual(2);
    expect(renderWatchTimeline(first.sessionId).totalEntries).toBe(0);
    expect(renderWatchTimeline(second.sessionId).totalEntries).toBe(0);
    for (const id of attachmentIds) {
      expect(attachmentExists(id)).toBe(false);
    }
  });
});
