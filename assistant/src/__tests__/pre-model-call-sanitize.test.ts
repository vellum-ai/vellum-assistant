import { describe, expect, test } from "bun:test";

import {
  preModelCallSanitize,
  wrapWatchEntry,
} from "../context/outbound-sanitize.js";
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

/**
 * A watch session's screenshots reach history on plain user messages rather
 * than tool results, and its entries run no turn, so nothing between them ever
 * trims the bytes. The marker is what makes them reachable: it separates
 * generated capture from an image the user attached themselves.
 */
describe("preModelCallSanitize: watch timeline media", () => {
  const watchScreenshot = (index: number, data: string): Message => ({
    role: "user",
    content: [
      {
        type: "text",
        text: wrapWatchEntry(
          `[t+00:${String(index).padStart(2, "0")}] screen:`,
        ),
      },
      {
        type: "image",
        source: { type: "base64", media_type: "image/jpeg", data },
      },
    ],
  });

  const blockTypes = (message: Message) =>
    message.content.map((block) => block.type);

  /** A session of `count` entries, each with its own identifiable screenshot. */
  const watchSession = (count: number): Message[] =>
    Array.from({ length: count }, (_, i) => watchScreenshot(i, `shot-${i}`));

  test("keeps a bounded window of watch screenshots and strips the rest", () => {
    // GIVEN seven marked watch entries, each carrying a screenshot
    const messages = watchSession(7);

    // WHEN the loop sanitizes the outbound history
    const result = preModelCallSanitize(messages);

    // THEN the entries beyond the retention window carry a placeholder
    const serialized = JSON.stringify(result);
    for (const i of [0, 1, 2]) {
      expect(serialized).not.toContain(`shot-${i}`);
      expect(blockTypes(result[i])).toEqual(["text", "text"]);
    }

    // AND the newest four still show the model the screen, because no turn
    // ever ran on them and this is the first request that carries them
    for (const i of [3, 4, 5, 6]) {
      expect(serialized).toContain(`shot-${i}`);
      expect(blockTypes(result[i])).toEqual(["text", "image"]);
    }

    // AND stripping is idempotent, so the projection is stable across sends
    expect(preModelCallSanitize(result)).toEqual(result);
  });

  test("keeps every screenshot of a session inside the window", () => {
    // GIVEN a session whose caller attached fewer screenshots than the bound
    const messages = watchSession(4);

    // WHEN the loop sanitizes the outbound history
    const result = preModelCallSanitize(messages);

    // THEN nothing is dropped: no model has seen any of them yet
    expect(result).toEqual(messages);
  });

  test("does not tell the model it already saw a dropped watch screenshot", () => {
    // GIVEN more watch screenshots than the retention window keeps
    const messages = watchSession(7);

    // WHEN the loop sanitizes the outbound history
    const stripped = preModelCallSanitize(messages)[0];

    // THEN the placeholder says the image was never shown, because a watch
    // entry runs no turn and no model ever saw it
    const placeholder = stripped.content[1];
    expect(placeholder.type).toBe("text");
    const text = placeholder.type === "text" ? placeholder.text : "";
    expect(text).toContain("never shown to the model");
    expect(text).not.toContain("shown previously");
  });

  test("leaves an unmarked user message's own image alone", () => {
    // GIVEN a user who attached two images across a conversation
    const messages: Message[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "here is the mockup" },
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: "mock-1" },
          },
        ],
      },
      { role: "assistant", content: [{ type: "text", text: "got it" }] },
      {
        role: "user",
        content: [
          { type: "text", text: "and the revision" },
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: "mock-2" },
          },
        ],
      },
    ];

    // WHEN the loop sanitizes the outbound history
    const result = preModelCallSanitize(messages);

    // THEN nothing the user sent is rewritten
    expect(result).toEqual(messages);
  });
});
