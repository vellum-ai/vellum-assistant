/**
 * Tests for the user-facing content projection: with the gate off nothing
 * moves, and with it on the model's plain text becomes private working notes
 * while each `send_user_message` call becomes the text the user reads.
 */

import { describe, expect, test } from "bun:test";

import type { ContentBlock } from "../../../providers/types.js";
import {
  hasSendUserMessageCall,
  projectUserFacingContent,
  sendUserMessageText,
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

  test("turns plain text into thinking and the tool call into text", () => {
    const content: ContentBlock[] = [
      { type: "text", text: "I should check the calendar." },
      sendCall("Checking your calendar."),
    ];
    expect(projectUserFacingContent(content, { toolGated: true })).toEqual([
      { type: "thinking", thinking: "I should check the calendar.", signature: "" },
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

  test("projects every send_user_message call in order", () => {
    const projected = projectUserFacingContent(
      [
        sendCall("First.", "tu_1"),
        { type: "text", text: "notes" },
        sendCall("Second.", "tu_2"),
      ] as ContentBlock[],
      { toolGated: true },
    );
    expect(projected.map((block) => block.type)).toEqual([
      "text",
      "thinking",
      "text",
    ]);
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
