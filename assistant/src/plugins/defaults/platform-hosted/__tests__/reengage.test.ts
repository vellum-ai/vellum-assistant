/**
 * Unit tests for the platform-hosted /reengage route handler.
 *
 * The route runs a background conversation turn and asks the assistant to write
 * `{ subject, body }` JSON to an injected file path under the plugin's data
 * directory, then reads it back. These tests mock `@vellumai/plugin-api` to
 * supply both a temp `getWorkspaceDir` (so the data dir is a throwaway temp
 * location) and a `runConversationTurn` that plays the assistant's part —
 * extracting the injected path from the prompt and writing (or not writing) a
 * file there.
 *
 * Covers:
 * - Happy path: model writes valid JSON → structured subject/body, file cleaned up
 * - Runs in a fresh background conversation
 * - Fenced JSON in the file → still parsed
 * - Model writes nothing → 502
 * - Model writes JSON missing a field → 502
 */

import { existsSync, mkdtempSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { RunConversationTurnOptions } from "@vellumai/plugin-api";

// ---------------------------------------------------------------------------
// Mock — supplies every named export reengage.ts imports from the plugin API:
// a temp `getWorkspaceDir`, and a `runConversationTurn` that plays the
// assistant (writes `fileContents`, if non-null, to the path injected into the
// prompt).
// ---------------------------------------------------------------------------

let workspaceDir = mkdtempSync(join(tmpdir(), "reengage-test-"));
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
  getWorkspaceDir: () => workspaceDir,
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
    workspaceDir = mkdtempSync(join(tmpdir(), "reengage-test-"));
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
