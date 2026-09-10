import { describe, expect, test } from "bun:test";

import { GEMINI_3_UNSIGNED_TOOL_CALL_THOUGHT_SIGNATURE } from "../../gemini-thought-signature.js";
import {
  applyGemini3UnsignedToolCallFallback,
  assistantToolCallsNeedThoughtSignatureBackfill,
  attachGoogleThoughtSignature,
  attachGoogleThoughtSignatureIfNeeded,
  backfillGoogleThoughtSignatures,
  backfillUnsignedGoogleThoughtSignatures,
  geminiThoughtSignaturesByToolCallId,
  googleThoughtSignatureFromUnknown,
  type GoogleToolCallExtraContent,
  messagesCarryGoogleThoughtSignature,
  stripGoogleThoughtSignatures,
  toolUseMetadataFromChatCompletionsDelta,
} from "../google-thought-signature.js";

describe("googleThoughtSignatureFromUnknown", () => {
  test("reads extra_content.google.thought_signature", () => {
    expect(
      googleThoughtSignatureFromUnknown({
        extra_content: { google: { thought_signature: "signed-thought-1" } },
      }),
    ).toBe("signed-thought-1");
  });

  test("reads camelCase thoughtSignature under google", () => {
    expect(
      googleThoughtSignatureFromUnknown({
        extra_content: { google: { thoughtSignature: "signed-thought-1" } },
      }),
    ).toBe("signed-thought-1");
  });

  test("ignores empty, missing, and non-object extra_content", () => {
    expect(googleThoughtSignatureFromUnknown(undefined)).toBeUndefined();
    expect(googleThoughtSignatureFromUnknown({})).toBeUndefined();
    expect(
      googleThoughtSignatureFromUnknown({ extra_content: "nope" }),
    ).toBeUndefined();
    expect(
      googleThoughtSignatureFromUnknown({
        extra_content: { google: { thought_signature: "" } },
      }),
    ).toBeUndefined();
  });
});

describe("attachGoogleThoughtSignature", () => {
  test("adds extra_content only when a signature is present", () => {
    expect(
      attachGoogleThoughtSignature({ id: "call_1" }, "signed-thought-1"),
    ).toEqual({
      id: "call_1",
      extra_content: { google: { thought_signature: "signed-thought-1" } },
    });
    expect(attachGoogleThoughtSignature({ id: "call_1" }, undefined)).toEqual({
      id: "call_1",
    });
  });
});

describe("attachGoogleThoughtSignatureIfNeeded", () => {
  test("attaches extra_content for Gemini 3 models", () => {
    expect(
      attachGoogleThoughtSignatureIfNeeded(
        { id: "call_1" },
        "signed-thought-1",
        "google/gemini-3.7-flash",
      ),
    ).toEqual({
      id: "call_1",
      extra_content: { google: { thought_signature: "signed-thought-1" } },
    });
  });

  test("does not attach extra_content for non-Gemini models", () => {
    expect(
      attachGoogleThoughtSignatureIfNeeded(
        { id: "call_1" },
        "signed-thought-1",
        "gpt-5.2",
      ),
    ).toEqual({ id: "call_1" });
  });
});

describe("toolUseMetadataFromChatCompletionsDelta", () => {
  test("maps extra_content onto gemini providerMetadata", () => {
    expect(
      toolUseMetadataFromChatCompletionsDelta({
        extra_content: { google: { thought_signature: "signed-thought-1" } },
      }),
    ).toEqual({ gemini: { thoughtSignature: "signed-thought-1" } });
  });

  test("returns undefined when extra_content is absent", () => {
    expect(toolUseMetadataFromChatCompletionsDelta({ id: "call_1" })).toBeUndefined();
  });
});

describe("applyGemini3UnsignedToolCallFallback", () => {
  test("adds the dummy signature to the first unsigned Gemini 3 tool_call", () => {
    const toolCalls: GoogleToolCallExtraContent[] = [{}, {}];
    applyGemini3UnsignedToolCallFallback(toolCalls, "google/gemini-3.7-flash");
    expect(toolCalls[0].extra_content).toEqual({
      google: {
        thought_signature: GEMINI_3_UNSIGNED_TOOL_CALL_THOUGHT_SIGNATURE,
      },
    });
    expect(toolCalls[1].extra_content).toBeUndefined();
  });

  test("does not overwrite a captured signature", () => {
    const toolCalls: GoogleToolCallExtraContent[] = [
      attachGoogleThoughtSignature({}, "signed-thought-1"),
      {},
    ];
    applyGemini3UnsignedToolCallFallback(toolCalls, "gemini-3.7-flash");
    expect(toolCalls[0].extra_content?.google?.thought_signature).toBe(
      "signed-thought-1",
    );
    expect(toolCalls[1].extra_content).toBeUndefined();
  });

  test("does not add extra_content for non-Gemini-3 models", () => {
    const toolCalls: GoogleToolCallExtraContent[] = [{}];
    applyGemini3UnsignedToolCallFallback(toolCalls, "gpt-5.2");
    expect(toolCalls[0].extra_content).toBeUndefined();
  });
});

describe("thought signature params helpers", () => {
  type ToolCallParams = {
    messages: Array<{
      role: string;
      tool_calls: Array<
        GoogleToolCallExtraContent & { id: string; type: string }
      >;
    }>;
  };

  const unsignedParams: ToolCallParams = {
    messages: [
      {
        role: "assistant",
        tool_calls: [{ id: "call_1", type: "function" }],
      },
    ],
  };

  const signedParams = {
    messages: [
      {
        role: "assistant",
        tool_calls: [
          attachGoogleThoughtSignature(
            { id: "call_1", type: "function" },
            "signed-thought-1",
          ),
        ],
      },
    ],
  };

  test("detects unsigned assistant tool_calls that need a backfill", () => {
    expect(assistantToolCallsNeedThoughtSignatureBackfill(unsignedParams)).toBe(
      true,
    );
    expect(assistantToolCallsNeedThoughtSignatureBackfill(signedParams)).toBe(
      false,
    );
    expect(messagesCarryGoogleThoughtSignature(unsignedParams)).toBe(false);
    expect(messagesCarryGoogleThoughtSignature(signedParams)).toBe(true);
  });

  test("backfills the dummy signature onto unsigned tool_calls", () => {
    const params = structuredClone(unsignedParams);
    expect(backfillUnsignedGoogleThoughtSignatures(params)).toBe(true);
    expect(messagesCarryGoogleThoughtSignature(params)).toBe(true);
    expect(
      params.messages[0].tool_calls[0].extra_content?.google?.thought_signature,
    ).toBe(GEMINI_3_UNSIGNED_TOOL_CALL_THOUGHT_SIGNATURE);
  });

  test("strips extra_content from assistant tool_calls", () => {
    const params = structuredClone(signedParams);
    expect(stripGoogleThoughtSignatures(params)).toBe(true);
    expect(messagesCarryGoogleThoughtSignature(params)).toBe(false);
    expect(params.messages[0].tool_calls[0].extra_content).toBeUndefined();
  });

  test("replays captured signatures by tool_call id on unsigned params", () => {
    const params = structuredClone(unsignedParams);
    expect(
      backfillGoogleThoughtSignatures(
        params,
        new Map([["call_1", "signed-thought-1"]]),
      ),
    ).toBe(true);
    expect(
      params.messages[0].tool_calls[0].extra_content?.google?.thought_signature,
    ).toBe("signed-thought-1");
  });
});

describe("geminiThoughtSignaturesByToolCallId", () => {
  test("indexes captured signatures from assistant tool_use blocks", () => {
    expect(
      geminiThoughtSignaturesByToolCallId([
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "call_1",
              name: "search",
              input: { q: "x" },
              providerMetadata: {
                gemini: { thoughtSignature: "signed-thought-1" },
              },
            },
            {
              type: "tool_use",
              id: "call_2",
              name: "search",
              input: { q: "y" },
            },
          ],
        },
      ]),
    ).toEqual(new Map([["call_1", "signed-thought-1"]]));
  });
});
