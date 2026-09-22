import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { DictationProfile } from "../../../daemon/dictation-profile-store.js";

let profile: DictationProfile;
let nextToolInput: { mode?: string; text?: string } | null;
let providerAvailable: boolean;
let providerFails: boolean;
let providerResolutions: number;
let requestedProperties: Record<string, unknown> | undefined;

mock.module("../../../providers/provider-send-message.js", () => ({
  getConfiguredProvider: async () => {
    providerResolutions += 1;
    if (!providerAvailable) {
      return null;
    }
    return {
      sendMessage: async (
        _messages: unknown,
        options: {
          tools: Array<{
            input_schema: { properties: Record<string, unknown> };
          }>;
        },
      ) => {
        if (providerFails) {
          throw new Error("Provider unavailable");
        }
        requestedProperties = options.tools[0]?.input_schema.properties;
        return {
          content: nextToolInput
            ? [{ type: "tool_use", input: nextToolInput }]
            : [{ type: "text", text: "Rewritten text." }],
        };
      },
    };
  },
  extractToolUse: (response: { content: Array<{ type: string }> }) =>
    response.content.find((block) => block.type === "tool_use"),
  userMessage: (text: string) => ({ role: "user", content: text }),
  createTimeout: () => ({ signal: undefined, cleanup: () => undefined }),
}));

mock.module("../../../daemon/dictation-profile-store.js", () => ({
  resolveProfile: () => ({ profile, source: "default" }),
}));

const { ROUTES, computeMaxTokens } = await import("../diagnostics-routes.js");
const route = ROUTES.find((entry) => entry.operationId === "dictation_post")!;

async function dictate(
  transcription: string,
  context: { cursorInTextField?: boolean; selectedText?: string } = {
    cursorInTextField: true,
  },
) {
  return (await route.handler({
    body: { transcription, context },
  } as unknown as Parameters<typeof route.handler>[0])) as {
    text: string;
    mode: string;
    actionPlan?: string;
  };
}

beforeEach(() => {
  profile = { id: "general", name: "General" };
  nextToolInput = { mode: "dictation", text: "We should ship it." };
  providerAvailable = true;
  providerFails = false;
  providerResolutions = 0;
  requestedProperties = undefined;
});

describe("dictation preserves recognized words", () => {
  test.each([
    "I think we probably shouldn't ship it, at least not yet.",
    "Um, I don't, I don't want to say yes. Maybe next week?",
    "First onions, then tomatoes. Actually, no tomatoes.",
    "  Please don't send that.\nI mean it.  ",
    "send me the draft, but don't send it to anyone else",
  ])(
    "preserves text-field dictation despite an attempted model rewrite: %s",
    async (words) => {
      expect(await dictate(words)).toMatchObject({
        mode: "dictation",
        text: words,
      });
      expect(providerResolutions).toBe(1);
    },
  );

  test("a style profile cannot automatically rewrite ordinary dictation", async () => {
    profile.stylePrompt = "Make every sentence confident and professional.";
    const words = "I guess maybe we shouldn't do this.";

    expect(await dictate(words)).toMatchObject({ text: words });
    expect(providerResolutions).toBe(1);
  });

  test("whitespace-only selection is ordinary dictation", async () => {
    expect(
      await dictate("Don't change my words.", {
        cursorInTextField: true,
        selectedText: "  \n ",
      }),
    ).toMatchObject({ mode: "dictation", text: "Don't change my words." });
    expect(providerResolutions).toBe(1);
  });

  test("keeps explicitly configured snippet and dictionary replacements", async () => {
    profile.snippets = [
      { trigger: "my sign off", expansion: "Thanks, user one" },
    ];
    profile.dictionary = [{ spoken: "user one", written: "Example User" }];

    expect(await dictate("Maybe later. my sign off")).toMatchObject({
      mode: "dictation",
      text: "Maybe later. Thanks, Example User",
    });
    expect(providerResolutions).toBe(1);
  });

  test("classification outside a text field cannot supply replacement text", async () => {
    const words = "I think we probably shouldn't ship it.";

    expect(await dictate(words, {})).toMatchObject({
      mode: "dictation",
      text: words,
    });
    expect(providerResolutions).toBe(1);
    expect(Object.keys(requestedProperties ?? {})).toEqual(["mode"]);
  });

  test.each([true, false])(
    "action classification preserves the original command with cursorInTextField=%s",
    async (cursorInTextField) => {
      nextToolInput = { mode: "action", text: "Send the files." };
      profile.snippets = [{ trigger: "files", expansion: "all files" }];
      const words = "Send the files, but not the private ones.";

      expect(await dictate(words, { cursorInTextField })).toMatchObject({
        mode: "action",
        text: words,
        actionPlan: `User wants to: ${words}`,
      });
    },
  );

  test.each([
    "missing-provider",
    "provider-error",
    "missing-tool",
    "invalid-mode",
  ])("classification fallback preserves words when %s", async (failure) => {
    providerAvailable = failure !== "missing-provider";
    providerFails = failure === "provider-error";
    nextToolInput = failure === "missing-tool" ? null : { mode: "invalid" };
    const words = "I don't think that's what I meant, you know?";

    expect(await dictate(words, {})).toMatchObject({
      mode: "dictation",
      text: words,
    });
  });
});

describe("selected-text output budget", () => {
  test("reserves space for the edit and tool-call JSON", () => {
    expect(computeMaxTokens(900)).toBeGreaterThan(600);
    expect(computeMaxTokens(5)).toBe(512);
  });
});
