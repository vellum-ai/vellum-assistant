/**
 * Gemini rejects a request whose `functionResponse` Content carries any other
 * kind of part, with the misleading
 * `Requests ending with a model turn are not supported.` Our agent loop emits
 * such mixed user messages whenever a tool call errors (`<system_notice>` text
 * blocks land beside the tool results) or after compaction folds context text
 * into the tool-result message, so these tests pin the split that keeps the
 * function-response Content pure.
 */
import { describe, expect, test } from "bun:test";

import type { ContentBlock, Message } from "../../types.js";
import { toGeminiContents } from "../to-gemini-contents.js";

const MODEL = "gemini-3.6-flash";

const PNG_BASE64 = "iVBORw0KGgo=";

function userMessage(content: ContentBlock[]): Message {
  return { role: "user", content };
}

function assistantMessage(content: ContentBlock[]): Message {
  return { role: "assistant", content };
}

function toolUse(id: string, name: string): ContentBlock {
  return { type: "tool_use", id, name, input: { arg: id } };
}

function toolResult(
  toolUseId: string,
  output: string,
  contentBlocks?: ContentBlock[],
): ContentBlock {
  return {
    type: "tool_result",
    tool_use_id: toolUseId,
    content: output,
    ...(contentBlocks ? { contentBlocks } : {}),
  };
}

describe("toGeminiContents", () => {
  test("splits the production failure shape into a pure function-response turn", () => {
    const messages: Message[] = [
      userMessage([{ type: "text", text: "check my calendar" }]),
      assistantMessage([
        {
          type: "ui_surface",
          surfaceId: "surface-1",
          surfaceType: "call_summary",
        },
        { type: "text", text: "Looking now." },
        toolUse("call-1", "list_events"),
        toolUse("call-2", "read_email"),
        toolUse("call-3", "search_memory"),
      ]),
      userMessage([
        toolResult("call-1", "ok"),
        toolResult("call-2", "error"),
        toolResult("call-3", "ok"),
        {
          type: "text",
          text: "<system_notice>This tool call returned an error.</system_notice>",
        },
        {
          type: "text",
          text: "<system_notice>Retry budget: 2</system_notice>",
        },
      ]),
    ];

    const contents = toGeminiContents(messages, MODEL);

    expect(contents).toHaveLength(4);
    expect(contents[0]?.role).toBe("user");
    expect(contents[0]?.parts).toEqual([{ text: "check my calendar" }]);

    expect(contents[1]?.role).toBe("model");
    expect(contents[1]?.parts?.map((p) => p.functionCall?.name)).toEqual([
      undefined,
      "list_events",
      "read_email",
      "search_memory",
    ]);

    // The function-response Content sits immediately after the model turn and
    // carries nothing but the responses to that turn's calls.
    expect(contents[2]?.role).toBe("user");
    expect(contents[2]?.parts).toHaveLength(3);
    expect(
      contents[2]?.parts?.every((part) => Boolean(part.functionResponse)),
    ).toBe(true);
    expect(contents[2]?.parts?.map((p) => p.functionResponse?.name)).toEqual([
      "list_events",
      "read_email",
      "search_memory",
    ]);

    // Everything else the user message carried rides a follow-up user Content,
    // in original block order.
    expect(contents[3]).toEqual({
      role: "user",
      parts: [
        {
          text: "<system_notice>This tool call returned an error.</system_notice>",
        },
        { text: "<system_notice>Retry budget: 2</system_notice>" },
      ],
    });
  });

  test("routes tool-result media and sibling text onto the same follow-up Content", () => {
    const messages: Message[] = [
      assistantMessage([toolUse("call-1", "screenshot")]),
      userMessage([
        toolResult("call-1", "captured", [
          { type: "text", text: "1280x720" },
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: PNG_BASE64,
            },
          },
        ]),
        { type: "text", text: "<system_notice>note</system_notice>" },
      ]),
    ];

    const contents = toGeminiContents(messages, MODEL);

    expect(contents).toHaveLength(3);
    expect(contents[1]?.parts).toEqual([
      {
        functionResponse: {
          name: "screenshot",
          response: { output: "captured\n1280x720" },
        },
      },
    ]);
    // Message-level parts come first, then media lifted out of the tool result.
    expect(contents[2]).toEqual({
      role: "user",
      parts: [
        { text: "<system_notice>note</system_notice>" },
        { inlineData: { mimeType: "image/png", data: PNG_BASE64 } },
      ],
    });
  });

  test("keeps a tool-result-only user message as a single Content", () => {
    const messages: Message[] = [
      assistantMessage([toolUse("call-1", "list_events")]),
      userMessage([toolResult("call-1", "ok")]),
    ];

    const contents = toGeminiContents(messages, MODEL);

    expect(contents).toHaveLength(2);
    expect(contents[1]).toEqual({
      role: "user",
      parts: [
        {
          functionResponse: {
            name: "list_events",
            response: { output: "ok" },
          },
        },
      ],
    });
  });

  test("keeps a plain text user message as a single Content", () => {
    const contents = toGeminiContents(
      [userMessage([{ type: "text", text: "hello" }])],
      MODEL,
    );

    expect(contents).toEqual([{ role: "user", parts: [{ text: "hello" }] }]);
  });

  test("keeps text and functionCall together in a model turn", () => {
    const contents = toGeminiContents(
      [
        assistantMessage([
          { type: "text", text: "one moment" },
          toolUse("call-1", "list_events"),
        ]),
      ],
      MODEL,
    );

    expect(contents).toHaveLength(1);
    expect(contents[0]?.parts).toHaveLength(2);
    expect(contents[0]?.parts?.[0]?.text).toBe("one moment");
    expect(contents[0]?.parts?.[1]?.functionCall?.name).toBe("list_events");
  });

  test("stamps the fallback thought signature on unsigned Gemini 3 tool calls", () => {
    const contents = toGeminiContents(
      [
        assistantMessage([
          toolUse("call-1", "list_events"),
          toolUse("call-2", "read_email"),
        ]),
      ],
      MODEL,
    );

    const parts = contents[0]?.parts ?? [];
    expect(parts[0]?.thoughtSignature).toBe(
      "context_engineering_is_the_way_to_go",
    );
    expect(parts[1]?.thoughtSignature).toBeUndefined();
  });

  test("leaves real thought signatures untouched and skips non-Gemini-3 models", () => {
    const signed = toGeminiContents(
      [
        assistantMessage([
          {
            type: "tool_use",
            id: "call-1",
            name: "list_events",
            input: {},
            providerMetadata: {
              gemini: { thoughtSignature: "real-signature" },
            },
          },
        ]),
      ],
      MODEL,
    );
    expect(signed[0]?.parts?.[0]?.thoughtSignature).toBe("real-signature");

    const legacy = toGeminiContents(
      [assistantMessage([toolUse("call-1", "list_events")])],
      "gemini-2.5-flash",
    );
    expect(legacy[0]?.parts?.[0]?.thoughtSignature).toBeUndefined();
  });
});
