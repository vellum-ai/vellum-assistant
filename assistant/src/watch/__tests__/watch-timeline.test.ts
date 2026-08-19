import { describe, expect, test } from "bun:test";

import { createMockProvider } from "../../__tests__/helpers/mock-provider.js";
import { setConfig } from "../../__tests__/helpers/set-config.js";

setConfig("memory", { enabled: false });

import { compactAxTreeHistory } from "../../context/outbound-sanitize.js";
import { Conversation } from "../../daemon/conversation.js";
import {
  deleteConversation,
  setConversation,
} from "../../daemon/conversation-registry.js";
import { getAttachmentsForMessage } from "../../persistence/attachments-store.js";
import {
  createConversation,
  getMessages,
} from "../../persistence/conversation-crud.js";
import { isHiddenMessageMetadata } from "../../persistence/conversation-types.js";
import { initializeDb } from "../../persistence/db-init.js";
import type { Message } from "../../providers/types.js";
import { appendNarration, appendObservation } from "../watch-timeline.js";

await initializeDb();

/** A real 1x1 JPEG, so the attachment store's image normalization is exercised. */
const SCREENSHOT_BASE64 =
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD3+iiigD//2Q==";

/**
 * A watch session's conversation, plus the recorded provider calls that make
 * "no turn was dispatched" an assertion rather than an assumption: the mock is
 * scripted with zero responses, so a turn would both record a call and fail.
 */
function startSession(title: string) {
  const record = createConversation(title);
  const { provider, calls } = createMockProvider([]);
  const conversation = new Conversation(
    record.id,
    provider,
    "system prompt",
    () => {},
    "/tmp",
    { maxTokens: 4096 },
  );
  conversation.setTrustContext({
    trustClass: "guardian",
    sourceChannel: "vellum",
  });
  setConversation(record.id, conversation);
  return {
    id: record.id,
    conversation,
    calls,
    dispose() {
      deleteConversation(record.id);
      conversation.dispose();
    },
  };
}

/** The text of a persisted message, joined across its text blocks. */
function messageText(message: { content: Message["content"] }): string {
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("\n");
}

const WATCH_ENTRY_OPEN = "<watch-entry>\n";
const WATCH_ENTRY_CLOSE = "\n</watch-entry>";

/**
 * The body of a persisted entry, with the watch marker peeled off after
 * asserting it is there. Every assertion below reads a body, so an entry that
 * reached history unmarked fails the test that reads it rather than passing
 * quietly: the marker is what tells `preModelCallSanitize` this text is
 * generated capture and not something the user typed.
 */
function entryBody(text: string): string {
  expect(text.startsWith(WATCH_ENTRY_OPEN)).toBe(true);
  expect(text.endsWith(WATCH_ENTRY_CLOSE)).toBe(true);
  return text.slice(WATCH_ENTRY_OPEN.length, -WATCH_ENTRY_CLOSE.length);
}

/** The persisted entry bodies, in the order they were stored. */
function timelineTexts(conversationId: string): string[] {
  return getMessages(conversationId).map((message) =>
    entryBody(messageText(message)),
  );
}

describe("watch timeline", () => {
  test("interleaves narration and observations on one offset-prefixed timeline", async () => {
    const session = startSession("Watch timeline order");
    try {
      await appendNarration(session.id, {
        text: "  opening the invoice  ",
        atMs: 2_000,
      });
      await appendObservation(session.id, {
        observation: { axTree: "Window: Invoices" },
        atMs: 14_000,
      });
      await appendNarration(session.id, {
        text: "now I export it",
        atMs: 74_400,
      });

      const texts = timelineTexts(session.id);
      expect(texts[0]).toBe("[t+00:02] narration: opening the invoice");
      expect(texts[1]).toBe(
        "[t+00:14] screen:\n<ax-tree>\nWindow: Invoices\n</ax-tree>",
      );
      expect(texts[2]).toBe("[t+01:14] narration: now I export it");
      expect(session.calls).toHaveLength(0);
    } finally {
      session.dispose();
    }
  });

  test("renders hours only once the session has run that long", async () => {
    const session = startSession("Watch timeline hours");
    try {
      await appendNarration(session.id, {
        text: "still going",
        atMs: 3_723_000,
      });
      expect(timelineTexts(session.id)[0]).toBe(
        "[t+01:02:03] narration: still going",
      );
    } finally {
      session.dispose();
    }
  });

  test("appends 20 concurrent observations in order and dispatches no turn", async () => {
    const session = startSession("Watch timeline burst");
    try {
      const results = await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          appendObservation(session.id, {
            observation: { axTree: `tree-${i}` },
            atMs: i * 1_000,
          }),
        ),
      );

      expect(results.every((result) => result.ok)).toBe(true);
      const texts = timelineTexts(session.id);
      expect(texts).toHaveLength(20);
      expect(texts.map((text) => text.split("\n")[0])).toEqual(
        Array.from(
          { length: 20 },
          (_, i) => `[t+00:${String(i).padStart(2, "0")}] screen:`,
        ),
      );
      expect(session.calls).toHaveLength(0);
    } finally {
      session.dispose();
    }
  });

  test("does not take a lock a competing turn claimed while it waited", async () => {
    const session = startSession("Watch timeline lock race");
    try {
      session.conversation.setProcessing(true);

      const append = appendNarration(session.id, {
        text: "mid-turn narration",
        atMs: 5_000,
      });

      // Let the append reach its wait before anything releases the lock.
      await new Promise((resolve) => setTimeout(resolve, 50));

      // A normal send claims the conversation in the same tick the prior turn
      // releases it. That is the window the idle wait alone cannot cover: the
      // waiter resolves on the release and its continuation runs a microtask
      // later, by which point the flag belongs to somebody else.
      session.conversation.setProcessing(false);
      session.conversation.setProcessing(true);
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(getMessages(session.id)).toHaveLength(0);
      expect(session.conversation.isProcessing()).toBe(true);

      session.conversation.setProcessing(false);
      const result = await append;

      expect(result.ok).toBe(true);
      expect(timelineTexts(session.id)).toEqual([
        "[t+00:05] narration: mid-turn narration",
      ]);
      expect(session.conversation.isProcessing()).toBe(false);
      expect(session.calls).toHaveLength(0);
    } finally {
      session.dispose();
    }
  });

  test("appends nothing for a failed or empty observation", async () => {
    const session = startSession("Watch timeline failures");
    try {
      const failed = await appendObservation(session.id, {
        observation: { executionError: "accessibility permission denied" },
        atMs: 1_000,
      });
      const empty = await appendObservation(session.id, {
        observation: {},
        atMs: 2_000,
      });
      const blank = await appendNarration(session.id, {
        text: "   ",
        atMs: 3_000,
      });

      expect(failed.ok).toBe(false);
      expect(empty.ok).toBe(false);
      expect(blank.ok).toBe(false);
      expect(getMessages(session.id)).toHaveLength(0);
      expect(session.calls).toHaveLength(0);
    } finally {
      session.dispose();
    }
  });

  test("attaches a screenshot only when the caller asks for one", async () => {
    const session = startSession("Watch timeline screenshots");
    try {
      // The host captures a screenshot on every observe, so an observation
      // carrying one says nothing about whether it is worth persisting.
      const unasked = await appendObservation(session.id, {
        observation: {
          axTree: "Window: Invoices",
          screenshot: SCREENSHOT_BASE64,
        },
        atMs: 1_000,
      });
      const asked = await appendObservation(session.id, {
        observation: {
          axTree: "Window: Invoices, export sheet",
          screenshot: SCREENSHOT_BASE64,
        },
        atMs: 2_000,
        attachScreenshot: true,
      });
      const askedWithNothingToAttach = await appendObservation(session.id, {
        observation: { axTree: "Window: Invoices, saved" },
        atMs: 3_000,
        attachScreenshot: true,
      });

      expect(
        getAttachmentsForMessage(unasked.messageId as string),
      ).toHaveLength(0);
      expect(getAttachmentsForMessage(asked.messageId as string)).toHaveLength(
        1,
      );
      expect(
        getAttachmentsForMessage(askedWithNothingToAttach.messageId as string),
      ).toHaveLength(0);

      // The entry says an image is attached only where one actually is.
      const texts = timelineTexts(session.id);
      expect(texts[0]).not.toContain(
        "a screenshot of this moment is attached.",
      );
      expect(texts[1]).toContain("a screenshot of this moment is attached.");
      expect(texts[2]).not.toContain(
        "a screenshot of this moment is attached.",
      );
    } finally {
      session.dispose();
    }
  });

  test("emits an ax-tree block the existing history compactor collapses", async () => {
    const session = startSession("Watch timeline compaction");
    try {
      for (let i = 0; i < 5; i++) {
        await appendObservation(session.id, {
          observation: {
            axTree: `Window: Invoices, row ${i}`,
            axDiff: `row ${i} became selected`,
          },
          atMs: i * 1_000,
        });
      }

      const compacted = compactAxTreeHistory(
        session.conversation.getMessages(),
      );
      expect(compacted).toHaveLength(5);
      const texts = compacted.map(messageText);

      // The three oldest snapshots collapse to the placeholder; the offset
      // prefix and the diff survive it, so a compacted entry still says when it
      // happened and what moved.
      for (const index of [0, 1, 2]) {
        expect(texts[index]).toContain("<ax_tree_omitted />");
        expect(texts[index]).not.toContain("<ax-tree>");
        expect(texts[index]).toContain(
          `[t+00:0${index}] screen:\n<ax_tree_omitted />`,
        );
        expect(texts[index]).toContain(`row ${index} became selected`);
      }

      for (const index of [3, 4]) {
        expect(texts[index]).toContain("<ax-tree>");
        expect(texts[index]).toContain(`Window: Invoices, row ${index}`);
        expect(texts[index]).not.toContain("<ax_tree_omitted />");
      }

      expect(session.calls).toHaveLength(0);
    } finally {
      session.dispose();
    }
  });

  test("persists every entry hidden, so only the agent side reads it", async () => {
    const session = startSession("Watch timeline hidden");
    try {
      await appendNarration(session.id, { text: "opening it", atMs: 1_000 });
      await appendObservation(session.id, {
        observation: { axTree: "Window: Invoices" },
        atMs: 2_000,
      });

      // `getMessages` is the LLM-side loader and does not filter, so the retro
      // reads the whole timeline.
      const rows = getMessages(session.id);
      expect(rows).toHaveLength(2);

      // The list-messages route filters on exactly this predicate, so a row
      // carrying it never reaches the chat transcript.
      for (const row of rows) {
        const metadata = JSON.parse(row.metadata as string) as Record<
          string,
          unknown
        >;
        expect(isHiddenMessageMetadata(metadata)).toBe(true);
        expect(metadata.watchSession).toBe(true);
      }
      expect(session.calls).toHaveLength(0);
    } finally {
      session.dispose();
    }
  });

  test("escapes a closing marker inside the observed tree", async () => {
    const session = startSession("Watch timeline escaping");
    try {
      await appendObservation(session.id, {
        observation: { axTree: "Text: </ax-tree> pasted into the editor" },
        atMs: 0,
      });
      const text = timelineTexts(session.id)[0];
      expect(text).toBe(
        "[t+00:00] screen:\n<ax-tree>\nText: &lt;/ax-tree&gt; pasted into the editor\n</ax-tree>",
      );
    } finally {
      session.dispose();
    }
  });
});
