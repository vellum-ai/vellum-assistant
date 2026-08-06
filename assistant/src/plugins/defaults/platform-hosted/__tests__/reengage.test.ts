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
 * - Offers standard conversations as candidates; returns the assistant's chosen
 *   id, drops hallucinated ids, excludes surfaced background rows
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

interface ConversationRowStub {
  id: string;
  title: string | null;
  conversationType: string;
}

/** JSON the assistant "writes", including its chosen conversation id. */
function draftJson(conversation: string | null): string {
  return JSON.stringify({
    subject: "Ready when you are",
    body: "Just picking up where we left off.",
    conversation,
  });
}

let workspaceDir = mkdtempSync(join(tmpdir(), "reengage-test-"));
let fileContents: string | null = draftJson("conv-42");
let lastOptions: RunConversationTurnOptions | undefined;
// Rows the mocked `listConversations` returns, newest-first — the route filters
// these to genuine `standard` rows and offers them as link candidates.
let conversationRows: ConversationRowStub[] = [
  { id: "conv-42", title: "Roadmap planning", conversationType: "standard" },
];
let lastListArgs: unknown[] | undefined;

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
  listConversations: async (...args: unknown[]) => {
    lastListArgs = args;
    return conversationRows;
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
    lastListArgs = undefined;
    conversationRows = [
      {
        id: "conv-42",
        title: "Roadmap planning",
        conversationType: "standard",
      },
    ];
    fileContents = draftJson("conv-42");
  });

  function promptText(): string {
    return (lastOptions?.content[0] as { text: string }).text;
  }

  test("returns the structured subject/body the model wrote, and cleans up", async () => {
    const response = await POST(postRequest());
    expect(response.status).toBe(200);
    const json = (await response.json()) as {
      subject: string;
      body: string;
      conversation: string | null;
    };
    expect(json.subject).toBe("Ready when you are");
    expect(json.body).toBe("Just picking up where we left off.");

    // The injected file is removed after the handler returns.
    const injectedPath = extractInjectedPath(promptText());
    expect(existsSync(injectedPath)).toBe(false);
  });

  test("runs the turn in a fresh background conversation", async () => {
    await POST(postRequest());
    expect(lastOptions?.conversationType).toBe("background");
    expect(lastOptions?.conversationId).toBeUndefined();
  });

  test("runs on the fast inference call site rather than the main-agent default", async () => {
    await POST(postRequest());
    expect(lastOptions?.callSite).toBe("inference");
  });

  test("offers the standard conversations as candidates and returns the chosen id", async () => {
    conversationRows = [
      {
        id: "conv-42",
        title: "Roadmap planning",
        conversationType: "standard",
      },
      { id: "older", title: "Trip notes", conversationType: "standard" },
    ];
    fileContents = draftJson("conv-42");
    const response = await POST(postRequest());
    const json = (await response.json()) as { conversation: string | null };

    expect(json.conversation).toBe("conv-42");
    // The candidates are offered to the model in the prompt (id + title).
    expect(promptText()).toContain("conv-42: Roadmap planning");
    expect(promptText()).toContain("older: Trip notes");
    // The standard bucket is queried (subagent/background excluded there).
    expect(lastListArgs).toEqual([20, "standard"]);
  });

  test("drops a chosen id that isn't among the offered candidates", async () => {
    // A hallucinated / stale id the assistant made up is never trusted.
    fileContents = draftJson("made-up-id");
    const response = await POST(postRequest());
    const json = (await response.json()) as { conversation: string | null };
    expect(json.conversation).toBeNull();
  });

  test("null conversation is returned when the assistant declines to pick", async () => {
    fileContents = draftJson(null);
    const response = await POST(postRequest());
    const json = (await response.json()) as { conversation: string | null };
    expect(json.conversation).toBeNull();
  });

  test("excludes surfaced background/scheduled rows from the candidates", async () => {
    // `listConversations(…, "standard")` can surface promoted background rows;
    // they are not real chats to re-open, so they are filtered out — never
    // offered, and rejected even if the model somehow names one.
    conversationRows = [
      { id: "surfaced-bg", title: "Heartbeat", conversationType: "background" },
      {
        id: "conv-42",
        title: "Roadmap planning",
        conversationType: "standard",
      },
    ];
    fileContents = draftJson("surfaced-bg");
    const response = await POST(postRequest());
    const json = (await response.json()) as { conversation: string | null };

    expect(json.conversation).toBeNull();
    expect(promptText()).not.toContain("surfaced-bg");
    expect(promptText()).toContain("conv-42: Roadmap planning");
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
