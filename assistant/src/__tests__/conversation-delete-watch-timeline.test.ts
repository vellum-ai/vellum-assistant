/**
 * A watch session's timeline is the most sensitive thing a conversation owns:
 * what the user narrated, and frames of their screen while they narrated it.
 * The frames are staged attachment files, so deleting the conversation row is
 * not enough on its own. Every path that removes a conversation has to take
 * the timeline rows, the attachment rows, and the files with it.
 *
 * `clearAll` is the sharpest case: it wipes the attachments table with bulk
 * SQL, which drops rows and leaves files, so the timeline needs its own purge
 * inside that wipe.
 */
import { existsSync } from "node:fs";
import { describe, expect, mock, test } from "bun:test";

// Keep the rest of the module real; only the Qdrant collection drop is
// replaced, so `clearAll` does not reach for a lexical index that is not
// running here.
const actualLexical =
  await import("../persistence/job-handlers/message-lexical.js");
mock.module("../persistence/job-handlers/message-lexical.js", () => ({
  ...actualLexical,
  clearMessagesLexicalIndex: async () => {},
}));

import {
  attachmentExists,
  getFilePathForAttachment,
} from "../persistence/attachments-store.js";
import {
  clearAll,
  createConversation,
  deleteConversation,
  deleteConversationGently,
} from "../persistence/conversation-crud.js";
import { initializeDb } from "../persistence/db-init.js";
import {
  appendNarration,
  appendObservation,
  renderWatchTimeline,
} from "../watch/watch-timeline.js";

await initializeDb();

/** A real 1x1 JPEG, so the attachment store's image normalization is exercised. */
const SCREENSHOT_BASE64 =
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD3+iiigD//2Q==";

interface WatchedConversation {
  readonly conversationId: string;
  readonly sessionId: string;
  readonly attachmentId: string;
  readonly filePath: string;
}

/** A conversation with one narration and one screenshot-carrying observation. */
async function seedWatchedConversation(
  title: string,
): Promise<WatchedConversation> {
  const conversation = createConversation(title);
  const sessionId = `watch-${conversation.id}`;

  await appendObservation(sessionId, {
    conversationId: conversation.id,
    atMs: 1_000,
    observation: { axTree: "window Mail", screenshot: SCREENSHOT_BASE64 },
    attachScreenshot: true,
  });
  appendNarration(sessionId, {
    conversationId: conversation.id,
    atMs: 2_000,
    text: "this is how I file it",
  });

  const rendered = renderWatchTimeline(sessionId);
  expect(rendered.totalEntries).toBe(2);
  const attachmentId = rendered.screenshotAttachmentIds[0];
  expect(attachmentId).toBeDefined();

  const filePath = getFilePathForAttachment(attachmentId as string);
  expect(filePath).not.toBeNull();
  expect(existsSync(filePath as string)).toBe(true);

  return {
    conversationId: conversation.id,
    sessionId,
    attachmentId: attachmentId as string,
    filePath: filePath as string,
  };
}

function expectPurged(watched: WatchedConversation): void {
  expect(renderWatchTimeline(watched.sessionId).totalEntries).toBe(0);
  expect(attachmentExists(watched.attachmentId)).toBe(false);
  expect(existsSync(watched.filePath)).toBe(false);
}

describe("deleteConversation purges the watch timeline", () => {
  test("takes the entries, the attachment rows, and the files", async () => {
    const watched = await seedWatchedConversation("watched-sync");
    const other = await seedWatchedConversation("watched-sync-other");

    deleteConversation(watched.conversationId);

    expectPurged(watched);
    // Scoped to the conversation being deleted, not the whole store.
    expect(renderWatchTimeline(other.sessionId).totalEntries).toBe(2);
    expect(attachmentExists(other.attachmentId)).toBe(true);
    expect(existsSync(other.filePath)).toBe(true);
  });
});

describe("deleteConversationGently purges the watch timeline", () => {
  test("the off-loop path clears the same state as the synchronous one", async () => {
    const watched = await seedWatchedConversation("watched-gentle");

    await deleteConversationGently(watched.conversationId);

    expectPurged(watched);
  });
});

describe("clearAll purges every watch timeline", () => {
  test("wipes the entries and the staged screenshot files", async () => {
    const first = await seedWatchedConversation("watched-clear-all-a");
    const second = await seedWatchedConversation("watched-clear-all-b");

    await clearAll();

    expectPurged(first);
    expectPurged(second);
  });
});
