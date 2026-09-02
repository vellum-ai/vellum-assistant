/**
 * Command mode of `POST /v1/dictation`: selected text with the words spoken
 * over it. The model is asked, through one forced tool call, whether the
 * words wanted the selection changed or asked about it, and the route answers
 * `command` with the edit or `question` with the words as they were.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";

type ToolInput = { kind?: string; text?: string };
let nextToolInput: ToolInput | null = null;
let forcedTool: string | undefined;

mock.module("../../../providers/provider-send-message.js", () => ({
  getConfiguredProvider: async () => ({
    sendMessage: async (
      _messages: unknown,
      options: { config?: { tool_choice?: { name?: string } } },
    ) => {
      forcedTool = options.config?.tool_choice?.name;
      return {
        content: nextToolInput
          ? [
              {
                type: "tool_use",
                id: "tool-1",
                name: "transform_selection",
                input: nextToolInput,
              },
            ]
          : [{ type: "text", text: "Sure, here it is." }],
      };
    },
  }),
  extractToolUse: (response: { content: Array<{ type: string }> }) =>
    response.content.find((block) => block.type === "tool_use"),
  userMessage: (text: string) => ({ role: "user", content: text }),
  createTimeout: () => ({ signal: undefined, cleanup: () => undefined }),
}));

mock.module("../../../daemon/dictation-profile-store.js", () => ({
  resolveProfile: () => ({
    profile: { id: "default", stylePrompt: "", dictionary: [], snippets: [] },
    source: "default",
  }),
}));

mock.module("../../../daemon/dictation-text-processing.js", () => ({
  applyDictionary: (text: string) => text,
  expandSnippets: (text: string) => text,
}));

const { ROUTES } = await import("../diagnostics-routes.js");
const route = ROUTES.find((r) => r.operationId === "dictation_post")!;

const SELECTION = "Please send me the files.";

async function speakOverSelection(transcription: string) {
  return (await route.handler({
    body: {
      transcription,
      context: {
        bundleIdentifier: "com.example.mail",
        appName: "Example Mail",
        windowTitle: "New Message",
        selectedText: SELECTION,
        cursorInTextField: true,
      },
    },
  } as unknown as Parameters<typeof route.handler>[0])) as {
    text: string;
    mode: string;
  };
}

afterEach(() => {
  nextToolInput = null;
  forcedTool = undefined;
});

describe("dictation command mode", () => {
  test("answers an instruction with the edit", async () => {
    nextToolInput = { kind: "edit", text: "Could you send the files over?" };

    const result = await speakOverSelection("make this friendlier");

    expect(forcedTool).toBe("transform_selection");
    expect(result).toMatchObject({
      mode: "command",
      text: "Could you send the files over?",
    });
  });

  test("answers a question with the words as they were", async () => {
    nextToolInput = { kind: "answer", text: "" };

    const result = await speakOverSelection("what does this mean");

    expect(result).toMatchObject({
      mode: "question",
      text: "what does this mean",
    });
  });

  test("an edit with nothing in it is a question", async () => {
    nextToolInput = { kind: "edit", text: "  " };

    const result = await speakOverSelection("is this right");

    expect(result.mode).toBe("question");
  });

  test("a model that answers in prose hands the selection back unchanged", async () => {
    nextToolInput = null;

    const result = await speakOverSelection("make this friendlier");

    expect(result).toMatchObject({ mode: "command", text: SELECTION });
  });
});
