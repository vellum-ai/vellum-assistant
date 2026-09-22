import { describe, expect, test } from "bun:test";

import type {
  Message,
  Provider,
  ProviderResponse,
  SendMessageOptions,
} from "../../providers/types.js";
import {
  ADDRESSIVITY_JUDGE_ANSWER_THRESHOLD,
  judgeAddressivity,
  VOICE_ADDRESSIVITY_JUDGE_CALL_SITE,
} from "../voice-addressivity-judge.js";

function text(role: "user" | "assistant", body: string): Message {
  return { role, content: [{ type: "text", text: body }] };
}

function jevResponse(noul: number): ProviderResponse {
  const answers = { answer: { type: "noul", noul } };
  return {
    content: [{ type: "text", text: JSON.stringify(answers) }],
    model: "jev-latest",
    usage: { inputTokens: 1, outputTokens: 1 },
    stopReason: "end_turn",
    rawResponse: { model: "jev-latest", answers },
  };
}

function fakeProvider(
  respond: (
    messages: Message[],
    options?: SendMessageOptions,
  ) => Promise<ProviderResponse>,
): Provider {
  return {
    name: "typesafe",
    sendMessage: respond,
  } as Provider;
}

describe("judgeAddressivity", () => {
  const history = [text("assistant", "Want me to email Priya the numbers?")];

  test("reads the turn as addressed at or above the threshold, through the judge call site", async () => {
    let seen: { body: unknown; options?: SendMessageOptions } | null = null;
    const judgement = await judgeAddressivity({
      conversationId: "conv-1",
      history,
      utterance: "Yeah, send it.",
      bargeIn: false,
      resolveProvider: async () =>
        fakeProvider(async (messages, options) => {
          const block = messages[0]!.content[0]!;
          seen = {
            body: JSON.parse(block.type === "text" ? block.text : ""),
            options,
          };
          return jevResponse(ADDRESSIVITY_JUDGE_ANSWER_THRESHOLD);
        }),
    });

    expect(judgement).toMatchObject({
      addressed: true,
      outcome: "addressed",
      noul: ADDRESSIVITY_JUDGE_ANSWER_THRESHOLD,
    });
    const request = seen as unknown as {
      body: {
        state: {
          caller_just_said: string;
          recent_conversation: string;
          assistant_was_speaking: boolean;
        };
        questions: { answer: { type: string } };
      };
      options: SendMessageOptions;
    };
    expect(request.body.state.caller_just_said).toBe("Yeah, send it.");
    expect(request.body.state.recent_conversation).toBe(
      "assistant: Want me to email Priya the numbers?",
    );
    expect(request.body.state.assistant_was_speaking).toBe(false);
    expect(request.body.questions.answer.type).toBe("noul");
    expect(
      (request.options.config as { callSite?: string } | undefined)?.callSite,
    ).toBe(VOICE_ADDRESSIVITY_JUDGE_CALL_SITE);
  });

  test("reads an aside to the room as not addressed, and reports the barge-in", async () => {
    let seenBargeIn: unknown = null;
    const judgement = await judgeAddressivity({
      conversationId: "conv-1",
      history,
      utterance: "no, the blue one, on the counter",
      bargeIn: true,
      resolveProvider: async () =>
        fakeProvider(async (messages) => {
          const block = messages[0]!.content[0]!;
          const body: unknown = JSON.parse(
            block.type === "text" ? block.text : "",
          );
          seenBargeIn = (body as { state: { assistant_was_speaking: unknown } })
            .state.assistant_was_speaking;
          return jevResponse(0.04);
        }),
    });

    expect(judgement).toMatchObject({
      addressed: false,
      outcome: "not_addressed",
      noul: 0.04,
    });
    expect(seenBargeIn).toBe(true);
  });

  test("is unavailable without a TypeSafe provider", async () => {
    const judgement = await judgeAddressivity({
      conversationId: "conv-1",
      history,
      utterance: "Open Spotify.",
      bargeIn: false,
      resolveProvider: async () => null,
    });

    expect(judgement).toMatchObject({
      addressed: true,
      outcome: "unavailable",
    });
  });

  test("an empty utterance is unavailable and never asks", async () => {
    let asked = false;
    const judgement = await judgeAddressivity({
      conversationId: "conv-1",
      history,
      utterance: "   ",
      bargeIn: false,
      resolveProvider: async () => {
        asked = true;
        return fakeProvider(async () => jevResponse(0.9));
      },
    });

    expect(judgement).toMatchObject({
      addressed: true,
      outcome: "unavailable",
    });
    expect(asked).toBe(false);
  });

  test("a provider error reads as addressed, so shadow data never invents an ignore", async () => {
    const judgement = await judgeAddressivity({
      conversationId: "conv-1",
      history,
      utterance: "Open Spotify.",
      bargeIn: false,
      resolveProvider: async () =>
        fakeProvider(async () => {
          throw new Error("503");
        }),
    });

    expect(judgement).toMatchObject({ addressed: true, outcome: "error" });
  });

  test("an unparseable answer reads as addressed", async () => {
    const judgement = await judgeAddressivity({
      conversationId: "conv-1",
      history,
      utterance: "Open Spotify.",
      bargeIn: false,
      resolveProvider: async () =>
        fakeProvider(async () => ({
          content: [{ type: "text", text: "sure thing" }],
          model: "jev-latest",
          usage: { inputTokens: 1, outputTokens: 1 },
          stopReason: "end_turn",
          rawResponse: { model: "jev-latest" },
        })),
    });

    expect(judgement).toMatchObject({ addressed: true, outcome: "error" });
  });
});
