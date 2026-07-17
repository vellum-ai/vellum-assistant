/**
 * Unit tests for the platform-hosted /reengage route handler.
 *
 * The route runs a background conversation turn and asks the assistant to write
 * `{ subject, body }` JSON to an injected file path, then reads it back. These
 * tests mock `runConversationTurn` to play the assistant's part: they extract
 * the injected path from the prompt and write (or don't write) a file there.
 *
 * Covers:
 * - Happy path: model writes valid JSON → structured subject/body, file cleaned up
 * - Runs in a fresh background conversation
 * - Fenced JSON in the file → still parsed
 * - Model writes nothing → 502
 * - Model writes JSON missing a field → 502
 */

import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { RunConversationTurnOptions } from "@vellumai/plugin-api";

// ---------------------------------------------------------------------------
// Mock — plays the assistant: writes whatever `fileContents` is set to (if not
// null) to the path injected into the prompt.
// ---------------------------------------------------------------------------

let fileContents: string | null = JSON.stringify({
  subject: "Ready when you are",
  body: "Just picking up where we left off.",
});
let lastOptions: RunConversationTurnOptions | undefined;

function extractInjectedPath(prompt: string): string {
  const match = prompt.match(/`([^`]+)`/);
  if (!match) {
    throw new Error("no injected path found in prompt");
  }
  return match[1];
}

mock.module("@vellumai/plugin-api", () => ({
  runConversationTurn: async (options: RunConversationTurnOptions) => {
    lastOptions = options;
    const prompt = (options.content[0] as { text: string }).text;
    if (fileContents !== null) {
      await writeFile(extractInjectedPath(prompt), fileContents, "utf8");
    }
    return { content: [], userMessageId: "msg-1", conversationId: "conv-1" };
  },
}));

const { POST } = await import("../routes/reengage.js");

function postRequest(): Request {
  return new Request(
    "http://plugin.internal/x/plugins/platform-hosted/reengage",
    { method: "POST" },
  );
}

describe("platform-hosted /reengage POST", () => {
  beforeEach(() => {
    lastOptions = undefined;
    fileContents = JSON.stringify({
      subject: "Ready when you are",
      body: "Just picking up where we left off.",
    });
  });

  test("returns the structured subject/body the model wrote, and cleans up", async () => {
    const response = await POST(postRequest());
    expect(response.status).toBe(200);
    const json = (await response.json()) as { subject: string; body: string };
    expect(json.subject).toBe("Ready when you are");
    expect(json.body).toBe("Just picking up where we left off.");

    // The injected file is removed after the handler returns.
    const injectedPath = extractInjectedPath(
      (lastOptions?.content[0] as { text: string }).text,
    );
    expect(existsSync(injectedPath)).toBe(false);
  });

  test("runs the turn in a fresh background conversation", async () => {
    await POST(postRequest());
    expect(lastOptions?.conversationType).toBe("background");
    expect(lastOptions?.conversationId).toBeUndefined();
  });

  test("tolerates JSON wrapped in a code fence", async () => {
    fileContents =
      '```json\n{"subject": "A quick nudge", "body": "Let me know."}\n```';
    const response = await POST(postRequest());
    const json = (await response.json()) as { subject: string; body: string };
    expect(json.subject).toBe("A quick nudge");
    expect(json.body).toBe("Let me know.");
  });

  test("returns 502 when the model writes no file", async () => {
    fileContents = null;
    const response = await POST(postRequest());
    expect(response.status).toBe(502);
  });

  test("returns 502 when the written JSON is missing a field", async () => {
    fileContents = JSON.stringify({ subject: "Only a subject" });
    const response = await POST(postRequest());
    expect(response.status).toBe(502);
  });
});
