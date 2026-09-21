import { describe, expect, test } from "bun:test";

import type {
  Message,
  Provider,
  ProviderResponse,
  SendMessageOptions,
} from "../../providers/types.js";
import {
  CONTINUATION_JUDGE_KEEP_THRESHOLD,
  createContinuationJudge,
  VOICE_CONTINUATION_JUDGE_CALL_SITE,
} from "../continuation-judge.js";

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
  return { name: "typesafe", sendMessage: respond } as Provider;
}

const baseArgs = {
  parentConversationId: "conv-1",
  interruptedRequest: "Can you hit join now for me?",
  signal: new AbortController().signal,
};

describe("createContinuationJudge", () => {
  test("drops below the threshold and asks with both utterances", async () => {
    let seen: { body: unknown; options?: SendMessageOptions } | null = null;
    const judge = createContinuationJudge({
      resolveProvider: async () =>
        fakeProvider(async (messages, options) => {
          const block = messages[0]!.content[0]!;
          seen = {
            body: JSON.parse(block.type === "text" ? block.text : ""),
            options,
          };
          return jevResponse(0.09);
        }),
    });

    const judgement = await judge({
      ...baseArgs,
      interruption: Promise.resolve("Actually just point it out for me."),
    });

    expect(judgement).toMatchObject({
      keep: false,
      outcome: "drop",
      noul: 0.09,
    });
    const request = seen as unknown as {
      body: { state: Record<string, string> };
      options: SendMessageOptions;
    };
    expect(request.body.state).toEqual({
      interrupted_request: "Can you hit join now for me?",
      caller_then_said: "Actually just point it out for me.",
    });
    expect(
      (request.options.config as { callSite?: string } | undefined)?.callSite,
    ).toBe(VOICE_CONTINUATION_JUDGE_CALL_SITE);
  });

  test("keeps at or above the threshold", async () => {
    const judge = createContinuationJudge({
      resolveProvider: async () =>
        fakeProvider(async () =>
          jevResponse(CONTINUATION_JUDGE_KEEP_THRESHOLD),
        ),
    });

    const judgement = await judge({
      ...baseArgs,
      interruption: Promise.resolve("Oh, also, what's the weather?"),
    });

    expect(judgement).toMatchObject({ keep: true, outcome: "keep" });
  });

  test("without a TypeSafe provider it keeps and never waits on the interruption", async () => {
    const judge = createContinuationJudge({
      resolveProvider: async () => null,
    });

    const judgement = await judge({
      ...baseArgs,
      // Never settles: the judge must not await it.
      interruption: new Promise<string | null>(() => {}),
    });

    expect(judgement).toMatchObject({ keep: true, outcome: "unavailable" });
  });

  test("keeps when no interruption arrived in time", async () => {
    let asked = false;
    const judge = createContinuationJudge({
      resolveProvider: async () =>
        fakeProvider(async () => {
          asked = true;
          return jevResponse(0.05);
        }),
    });

    const judgement = await judge({
      ...baseArgs,
      interruption: Promise.resolve(null),
    });

    expect(judgement).toMatchObject({
      keep: true,
      outcome: "no_interruption",
    });
    expect(asked).toBe(false);
  });

  test("a provider error or timeout keeps the continuation", async () => {
    const failing = createContinuationJudge({
      resolveProvider: async () =>
        fakeProvider(async () => {
          throw new Error("503");
        }),
    });
    const hanging = createContinuationJudge({
      timeoutMs: 20,
      resolveProvider: async () =>
        fakeProvider(async () => new Promise<ProviderResponse>(() => {})),
    });

    expect(
      await failing({ ...baseArgs, interruption: Promise.resolve("stop") }),
    ).toMatchObject({ keep: true, outcome: "error" });
    expect(
      await hanging({ ...baseArgs, interruption: Promise.resolve("stop") }),
    ).toMatchObject({ keep: true, outcome: "timeout" });
  });
});
