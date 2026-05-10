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
      // enclosing object literal for a `conversationId` key. Scope the scan to
      // the matched `{ ... }` that contains `type:` so an adjacent event (e.g.
      // a following `message_complete` that happens to carry `conversationId`)
      // cannot mask a missing field on the delta itself.
      const TYPE_LITERAL = /type:\s*"assistant_text_delta"/g;
      const offsets: number[] = [];
      let match: RegExpExecArray | null;
      while ((match = TYPE_LITERAL.exec(source)) !== null) {
        offsets.push(match.index);
      }
      expect(offsets.length).toBeGreaterThan(0);

      const violations: string[] = [];
      for (const offset of offsets) {
        let openIdx = -1;
        for (let i = offset; i >= 0; i--) {
          if (source[i] === "{") {
            openIdx = i;
            break;
          }
        }
        let body = "";
        if (openIdx === -1) {
          body = source.slice(offset, offset + 200);
        } else {
          let depth = 0;
          let closeIdx = -1;
          for (let i = openIdx; i < source.length; i++) {
            if (source[i] === "{") depth++;
            else if (source[i] === "}") {
              depth--;
              if (depth === 0) {
                closeIdx = i;
                break;
              }
            }
          }
          body = source.slice(
            openIdx,
            closeIdx === -1 ? undefined : closeIdx + 1,
          );
        }
        if (!/conversationId/.test(body)) {
          const lineNumber = source.slice(0, offset).split("\n").length;
          violations.push(`${relativePath}:${lineNumber}`);
        }
      }
      expect(violations).toEqual([]);
    });
  }
});
