import { describe, test, expect } from "bun:test";

import { parseMessageArgs } from "../commands/message.js";

describe("parseMessageArgs", () => {
  test("parses an inline message with the active assistant", () => {
    const r = parseMessageArgs(["hello"]);
    expect(r).toEqual({
      ok: true,
      value: {
        conversationKey: undefined,
        jsonOutput: false,
        inlineMessage: "hello",
      },
    });
  });

  test("parses an explicit assistant plus inline message", () => {
    const r = parseMessageArgs(["my-assistant", "ping"]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.assistantId).toBe("my-assistant");
    expect(r.value.inlineMessage).toBe("ping");
    expect(r.value.filePath).toBeUndefined();
  });

  test("requires message content when nothing is provided", () => {
    const r = parseMessageArgs([]);
    expect(r).toEqual({ ok: false, error: "message content is required." });
  });

  test("reads content from --file with the active assistant", () => {
    const r = parseMessageArgs(["--file", "prompt.txt"]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.filePath).toBe("prompt.txt");
    expect(r.value.assistantId).toBeUndefined();
    expect(r.value.inlineMessage).toBeUndefined();
  });

  test("reads content from --file with an explicit assistant", () => {
    const r = parseMessageArgs(["my-assistant", "--file", "prompt.txt"]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.assistantId).toBe("my-assistant");
    expect(r.value.filePath).toBe("prompt.txt");
  });

  test("supports stdin via --file -", () => {
    const r = parseMessageArgs(["--file", "-"]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.filePath).toBe("-");
  });

  test("rejects combining --file with an inline message", () => {
    const r = parseMessageArgs(["my-assistant", "extra", "--file", "p.txt"]);
    expect(r).toEqual({
      ok: false,
      error: "--file cannot be combined with an inline message argument.",
    });
  });

  test("rejects --file without a path argument", () => {
    const r = parseMessageArgs(["my-assistant", "--file"]);
    expect(r).toEqual({
      ok: false,
      error: "--file requires a path argument.",
    });
  });

  test("preserves --conversation-key and --json alongside --file", () => {
    const r = parseMessageArgs([
      "--json",
      "--conversation-key",
      "thread-1",
      "--file",
      "prompt.txt",
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.jsonOutput).toBe(true);
    expect(r.value.conversationKey).toBe("thread-1");
    expect(r.value.filePath).toBe("prompt.txt");
  });
});
