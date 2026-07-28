import { describe, expect, test } from "bun:test";

import { preModelCallSanitize } from "../context/outbound-sanitize.js";
import type { Message } from "../providers/types.js";

/**
 * `preModelCallSanitize` is the loop's single pre-send transform: it converts
 * historical `web_search_tool_result` blocks to text alongside the media and
 * AX-tree strips, so every provider call — first call, post-compaction, and
 * recovery reruns — is sanitized in one place. These tests guard that the
 * helper actually performs the web-search conversion and is idempotent.
 */
describe("preModelCallSanitize", () => {
  test("passes through history with nothing to sanitize", () => {
    // GIVEN a plain conversation with no media, AX trees, or web-search blocks
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "Hello" }] },
      { role: "assistant", content: [{ type: "text", text: "Hi" }] },
    ];

    // WHEN the loop sanitizes the outbound history
    const result = preModelCallSanitize(messages);

    // THEN the history is returned unchanged
    expect(result).toEqual(messages);
  });

  test("converts historical web_search_tool_result blocks to text summaries", () => {
    // GIVEN an assistant turn whose web_search_tool_result carries an opaque
    // encrypted_content token that would be rejected if replayed
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "Search cats" }] },
      {
        role: "assistant",
        content: [
          {
            type: "server_tool_use",
            id: "stu_1",
            name: "web_search",
            input: { query: "cats" },
          },
          {
            type: "web_search_tool_result",
            tool_use_id: "stu_1",
            content: [
              {
                type: "web_search_result",
                url: "https://cats.com",
                title: "Cats!",
                encrypted_content: "expired_token_1",
              },
            ],
          },
        ],
      },
    ];

    // WHEN the loop sanitizes the outbound history
    const result = preModelCallSanitize(messages);

    // THEN the opaque block is replaced with a plaintext title+URL summary and
    // the paired server_tool_use is dropped, so no expired token is replayed
    const assistantMsg = result[1];
    expect(assistantMsg.content.map((b) => b.type)).toEqual(["text"]);
    const summary = assistantMsg.content[0];
    expect(summary.type).toBe("text");
    if (summary.type === "text") {
      expect(summary.text).toContain("Cats!");
      expect(summary.text).toContain("https://cats.com");
      expect(summary.text).not.toContain("expired_token_1");
    }
  });

  test("is idempotent — re-sanitizing already-sanitized history is a no-op", () => {
    // GIVEN history that has already been sanitized once
    const messages: Message[] = [
      {
        role: "assistant",
        content: [
          {
            type: "server_tool_use",
            id: "stu_A",
            name: "web_search",
            input: { query: "alpha" },
          },
          {
            type: "web_search_tool_result",
            tool_use_id: "stu_A",
            content: [
              {
                type: "web_search_result",
                url: "https://a.example",
                title: "A",
                encrypted_content: "tok_A",
              },
            ],
          },
        ],
      },
    ];
    const once = preModelCallSanitize(messages);

    // WHEN it is sanitized a second time (every outbound call re-runs the helper)
    const twice = preModelCallSanitize(once);

    // THEN the second pass changes nothing
    expect(twice).toEqual(once);
  });
});
