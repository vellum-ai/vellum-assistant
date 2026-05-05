/**
 * Guard test: every `assistant_text_delta` emission in the `/compact` and
 * other slash-command completion paths must carry `conversationId` on the
 * message body.
 *
 * Without this, a long-running compaction can finish after the user has
 * switched conversations, and the macOS client's `belongsToConversation(nil)`
 * check (which accepts nil ids as system events) renders the completion text
 * into whichever VM is currently active — leaking the message into the
 * wrong conversation.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

const SCANNED_FILES = [
  "runtime/routes/conversation-routes.ts",
  "daemon/conversation-process.ts",
];

describe("compact slash-command emits conversationId on assistant_text_delta", () => {
  for (const relativePath of SCANNED_FILES) {
    test(`${relativePath} tags every assistant_text_delta with conversationId`, () => {
      const fullPath = join(__dirname, "..", relativePath);
      const source = readFileSync(fullPath, "utf-8");

      // Find every `type: "assistant_text_delta"` literal and inspect the
      // surrounding object literal for a `conversationId` key. Looking at a
      // ~200-char window forward covers multi-line object literals while
      // staying tight enough to avoid matching unrelated nearby code.
      const TYPE_LITERAL = /type:\s*"assistant_text_delta"/g;
      const offsets: number[] = [];
      let match: RegExpExecArray | null;
      while ((match = TYPE_LITERAL.exec(source)) !== null) {
        offsets.push(match.index);
      }
      expect(offsets.length).toBeGreaterThan(0);

      const violations: string[] = [];
      for (const offset of offsets) {
        const window = source.slice(offset, offset + 200);
        if (!/conversationId/.test(window)) {
          const lineNumber = source.slice(0, offset).split("\n").length;
          violations.push(`${relativePath}:${lineNumber}`);
        }
      }
      expect(violations).toEqual([]);
    });
  }
});
