/**
 * Tests for the user-facing content projection: with the gate off nothing
 * moves, and with it on the model's plain text becomes private working notes
 * while each `send_user_message` call becomes the text the user reads.
 */

import { describe, expect, test } from "bun:test";

import type { ContentBlock } from "../../providers/types.js";
import {
  assistantTextVisibilityOf,
  hasSendUserMessageCall,
  isPrivateAssistantText,
  projectPersistedAssistantContent,
  projectUserFacingContent,
  sendUserMessageText,
  userFacingBlocksOfRow,
} from "../user-facing-content.js";

function sendCall(message: unknown, id = "tu_1"): ContentBlock {
  return {
    type: "tool_use",
    id,
    name: "send_user_message",
    input: { message },
  } as ContentBlock;
}

describe("projectUserFacingContent", () => {
  test("returns the content untouched when the gate is off", () => {
    const content: ContentBlock[] = [
      { type: "text", text: "thinking out loud" },
      sendCall("Done."),
    ];
    expect(projectUserFacingContent(content, { toolGated: false })).toBe(
      content,
    );
  });

  test("drops the scratchpad and turns the tool call into text", () => {
    const content: ContentBlock[] = [
      { type: "text", text: "I should check the calendar." },
      sendCall("Checking your calendar."),
    ];
    expect(projectUserFacingContent(content, { toolGated: true })).toEqual([
      { type: "text", text: "Checking your calendar." },
    ] as unknown as ContentBlock[]);
  });

  test("passes other blocks through unchanged", () => {
    const other: ContentBlock = {
      type: "tool_use",
      id: "tu_2",
      name: "bash",
      input: { command: "ls" },
    } as ContentBlock;
    const projected = projectUserFacingContent([other], { toolGated: true });
    expect(projected[0]).toBe(other);
  });

  test("leaves a send_user_message call with no usable message alone", () => {
    const bad = sendCall("   ");
    const projected = projectUserFacingContent([bad], { toolGated: true });
    expect(projected[0]).toBe(bad);
  });

  test("is a no-op for content that is not an array", () => {
    expect(projectUserFacingContent("legacy row", { toolGated: true })).toBe(
      "legacy row",
    );
  });

  test("folds every send_user_message call of a response into one block", () => {
    // The loop streams a response's messages as a single `text_delta`, and a
    // channel whose stream IS the reply counts one delivered segment for it.
    // The projection has to agree, or durable reconciliation posts the second
    // message again underneath the finished stream. The run rides the first
    // call's position, joined the way the live emission joins it.
    const projected = projectUserFacingContent(
      [
        sendCall("First.", "tu_1"),
        { type: "text", text: "notes" },
        sendCall("Second.", "tu_2"),
      ] as ContentBlock[],
      { toolGated: true },
    );
    expect(projected.map((block) => block.type)).toEqual(["text"]);
    expect((projected[0] as { text: string }).text).toBe("First.\n\nSecond.");
  });

  test("a single call is unchanged by the fold", () => {
    const projected = projectUserFacingContent(
      [{ type: "text", text: "notes" }, sendCall("Only.")] as ContentBlock[],
      { toolGated: true },
    );
    expect(projected.map((block) => block.type)).toEqual(["text"]);
    expect((projected[0] as { text: string }).text).toBe("Only.");
  });
});

describe("sendUserMessageText", () => {
  test("reads the message off a send_user_message call", () => {
    expect(sendUserMessageText(sendCall("Hello."))).toBe("Hello.");
  });

  test("is null for another tool, a blank message, and a non-block", () => {
    expect(
      sendUserMessageText({
        type: "tool_use",
        id: "x",
        name: "bash",
        input: { message: "Hello." },
      }),
    ).toBeNull();
    expect(sendUserMessageText(sendCall(""))).toBeNull();
    expect(sendUserMessageText(sendCall(42))).toBeNull();
    expect(sendUserMessageText(null)).toBeNull();
  });
});

describe("assistantTextVisibilityOf", () => {
  test("reads the marker from a raw metadata string and a parsed record", () => {
    expect(
      assistantTextVisibilityOf('{"assistantTextVisibility":"private"}'),
    ).toBe("private");
    expect(
      assistantTextVisibilityOf({ assistantTextVisibility: "visible" }),
    ).toBe("visible");
  });

  test("is undefined for an unmarked, malformed, or unknown-value row", () => {
    expect(assistantTextVisibilityOf(undefined)).toBeUndefined();
    expect(assistantTextVisibilityOf("{not json")).toBeUndefined();
    expect(assistantTextVisibilityOf('{"sentAt":1}')).toBeUndefined();
    expect(
      assistantTextVisibilityOf({ assistantTextVisibility: "later" }),
    ).toBeUndefined();
  });

  test("only a private row is projected", () => {
    expect(isPrivateAssistantText({ assistantTextVisibility: "private" })).toBe(
      true,
    );
    expect(isPrivateAssistantText({ assistantTextVisibility: "visible" })).toBe(
      false,
    );
    expect(isPrivateAssistantText(undefined)).toBe(false);
  });
});

describe("projectPersistedAssistantContent", () => {
  const stored = JSON.stringify([
    { type: "text", text: "working notes" },
    {
      type: "tool_use",
      id: "tu_1",
      name: "send_user_message",
      input: { message: "Done." },
    },
  ]);

  test("projects a row marked private", () => {
    const projected = projectPersistedAssistantContent(
      stored,
      '{"assistantTextVisibility":"private"}',
    );
    expect(projected).toEqual([
      { type: "text", text: "Done." },
    ] as unknown as ContentBlock[]);
  });

  test("leaves a fallback row (visible) and an unmarked row untouched", () => {
    expect(
      projectPersistedAssistantContent(
        stored,
        '{"assistantTextVisibility":"visible"}',
      ),
    ).toBe(stored);
    expect(projectPersistedAssistantContent(stored, undefined)).toBe(stored);
  });

  test("leaves a legacy string row untouched even when marked", () => {
    expect(
      projectPersistedAssistantContent(
        "plain legacy text",
        '{"assistantTextVisibility":"private"}',
      ),
    ).toBe("plain legacy text");
  });
});

describe("hasSendUserMessageCall", () => {
  test("finds a usable call anywhere in the content", () => {
    expect(
      hasSendUserMessageCall([{ type: "text", text: "x" }, sendCall("Hi.")]),
    ).toBe(true);
  });

  test("is false for content with no usable call", () => {
    expect(hasSendUserMessageCall([{ type: "text", text: "x" }])).toBe(false);
    expect(hasSendUserMessageCall(undefined)).toBe(false);
  });
});

describe("the redaction rider on a projected message", () => {
  test("carries the persist path's rider onto the text block it becomes", () => {
    // The message is redacted when the row is built, so a sentinel inside it
    // is redactor-authored. Without the rider the history renderer would read
    // the projected block as pre-feature and neutralize that sentinel.
    const call = sendCall(
      "key: 〔redacted:OpenAI Project Key:openai:api_key〕",
    );
    (call as unknown as Record<string, unknown>)["_redactionVersion"] = 2;

    const [projected] = projectUserFacingContent([call], {
      toolGated: true,
    }) as unknown as Array<Record<string, unknown>>;

    expect(projected.type).toBe("text");
    expect(projected._redactionVersion).toBe(2);
  });

  test("adds no rider when the source call never carried one", () => {
    const [projected] = projectUserFacingContent([sendCall("Hi.")], {
      toolGated: true,
    }) as unknown as Array<Record<string, unknown>>;

    expect(projected).toEqual({ type: "text", text: "Hi." });
  });
});

/**
 * `/messages` consolidates a turn's assistant rows into one content array and
 * then projects it, so the fold has to respect where one model response ended
 * and the next began. Tool activity between two messages is exactly that
 * boundary: fold across it and reload shows the result above the work it came
 * from.
 */
describe("response boundaries inside a consolidated turn", () => {
  const toolCall = (name: string, id = "tu_work"): ContentBlock =>
    ({ type: "tool_use", id, name, input: {} }) as ContentBlock;

  test("a tool call between two messages keeps them separate, in order", () => {
    // The shape a turn leaves after consolidation: progress, the work, result.
    const projected = projectUserFacingContent(
      [
        sendCall("Checking your calendar.", "tu_1"),
        toolCall("bash"),
        sendCall("Two meetings today.", "tu_2"),
      ] as ContentBlock[],
      { toolGated: true },
    ) as unknown as Array<Record<string, unknown>>;

    expect(projected.map((block) => block.type)).toEqual([
      "text",
      "tool_use",
      "text",
    ]);
    expect(projected[0].text).toBe("Checking your calendar.");
    expect(projected[2].text).toBe("Two meetings today.");
  });

  test("two calls with no work between them still fold into one segment", () => {
    const projected = projectUserFacingContent(
      [
        sendCall("First.", "tu_1"),
        sendCall("Second.", "tu_2"),
      ] as ContentBlock[],
      { toolGated: true },
    ) as unknown as Array<Record<string, unknown>>;

    expect(projected.map((block) => block.type)).toEqual(["text"]);
    expect(projected[0].text).toBe("First.\n\nSecond.");
  });

  test("the dropped scratchpad does not break a run", () => {
    // A text block renders no text of its own once demoted, so nothing of it
    // appears between the two messages.
    const projected = projectUserFacingContent(
      [
        sendCall("First.", "tu_1"),
        { type: "text", text: "notes" },
        sendCall("Second.", "tu_2"),
      ] as ContentBlock[],
      { toolGated: true },
    ) as unknown as Array<Record<string, unknown>>;

    expect(projected.map((block) => block.type)).toEqual(["text"]);
    expect(projected[0].text).toBe("First.\n\nSecond.");
  });

  test("three responses worth of messages keep all three boundaries", () => {
    const projected = projectUserFacingContent(
      [
        sendCall("One.", "tu_1"),
        toolCall("bash", "w1"),
        sendCall("Two.", "tu_2"),
        toolCall("file_read", "w2"),
        sendCall("Three.", "tu_3"),
      ] as ContentBlock[],
      { toolGated: true },
    ) as unknown as Array<Record<string, unknown>>;

    expect(
      projected
        .filter((block) => block.type === "text")
        .map((block) => block.text),
    ).toEqual(["One.", "Two.", "Three."]);
  });
});

/**
 * With the gate on, nothing of the model's private reasoning reaches the user
 * in any form. Demoting plain text to `thinking` put a "Thinking" row above
 * every delivered message, which is the opposite of what the gate is for, so
 * both block kinds are dropped outright.
 */
describe("the scratchpad on a private row", () => {
  const scratchpad: ContentBlock[] = [
    { type: "text", text: "the user wants their calendar" },
    { type: "thinking", thinking: "reasoning at length", signature: "sig" },
    {
      type: "redacted_thinking",
      data: "opaque",
    } as unknown as ContentBlock,
    sendCall("Two meetings today."),
    {
      type: "tool_use",
      id: "tu_work",
      name: "bash",
      input: { command: "cal" },
    } as ContentBlock,
  ];

  test("drops plain text and both reasoning block kinds", () => {
    const projected = projectUserFacingContent(scratchpad, {
      toolGated: true,
    }) as unknown as Array<Record<string, unknown>>;

    expect(projected.map((block) => block.type)).toEqual(["text", "tool_use"]);
    expect(projected[0].text).toBe("Two meetings today.");
    expect(JSON.stringify(projected)).not.toContain("reasoning at length");
    expect(JSON.stringify(projected)).not.toContain("wants their calendar");
  });

  test("keeps every one of them on an unmarked row", () => {
    // The gate is a property of the row: an ordinary row is untouched, so its
    // reasoning still renders exactly as it does today.
    expect(projectUserFacingContent(scratchpad, { toolGated: false })).toBe(
      scratchpad,
    );
  });

  test("an export of a private row carries no reasoning either", () => {
    const blocks = userFacingBlocksOfRow(
      scratchpad,
      '{"assistantTextVisibility":"private"}',
    );

    expect(blocks.map((block) => block.type)).toEqual(["text", "tool_use"]);
  });
});
