/**
 * Tests for the `send_user_message` tool definition: input validation and the
 * no-op execution contract. Delivery happens in the agent loop (the message is
 * streamed just before `message_complete`), so the executor only acknowledges.
 */

import { describe, expect, test } from "bun:test";

import { SEND_USER_MESSAGE_TOOL_NAME } from "../../config/send-user-message-gate.js";
import { sendUserMessageTool } from "./send-user-message-tool.js";

describe("send_user_message tool", () => {
  test("is named from the shared constant", () => {
    expect(sendUserMessageTool.name).toBe(SEND_USER_MESSAGE_TOOL_NAME);
    expect(sendUserMessageTool.name).toBe("send_user_message");
  });

  test("declares message as the only required input", () => {
    const schema = sendUserMessageTool.input_schema as {
      properties: Record<string, unknown>;
      required?: string[];
    };
    expect(Object.keys(schema.properties)).toContain("message");
    expect(schema.required).toEqual(["message"]);
  });

  test("tells the model that plain text never reaches the user", () => {
    expect(sendUserMessageTool.description).toContain("ONLY channel");
    expect(sendUserMessageTool.description).toContain("private working notes");
    expect(sendUserMessageTool.description).toContain("1 to 3 plain sentences");
  });

  test("acknowledges a valid message without side effects", async () => {
    const result = await sendUserMessageTool.execute({
      message: "Checking your calendar now.",
    });
    expect(result.isError).toBe(false);
    expect(result.content.length).toBeGreaterThan(0);
  });

  test("rejects an empty message", async () => {
    const result = await sendUserMessageTool.execute({ message: "" });
    expect(result.isError).toBe(true);
  });

  test("rejects a missing message", async () => {
    const result = await sendUserMessageTool.execute({});
    expect(result.isError).toBe(true);
  });
});
