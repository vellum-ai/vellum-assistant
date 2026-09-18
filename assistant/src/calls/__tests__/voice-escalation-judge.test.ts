import { describe, expect, test } from "bun:test";

import type {
  Message,
  Provider,
  ProviderResponse,
  SendMessageOptions,
} from "../../providers/types.js";
import {
  ESCALATION_JUDGE_THRESHOLD,
  judgeEscalation,
  recentConversationForJudge,
  VOICE_ESCALATION_JUDGE_CALL_SITE,
} from "../voice-escalation-judge.js";

function text(role: "user" | "assistant", body: string): Message {
  return { role, content: [{ type: "text", text: body }] };
}

function jevResponse(noul: number): ProviderResponse {
  const answers = { needs_escalation: { type: "noul", noul } };
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

describe("recentConversationForJudge", () => {
  test("keeps the last spoken turns, drops injected blocks and the current utterance", () => {
    const history: Message[] = [
      text("user", "hey"),
      text("assistant", "Want me to email Priya the numbers?"),
      {
        role: "user",
        content: [
          { type: "text", text: "<turn_context>\nnoise\n</turn_context>" },
          { type: "text", text: "Yeah go ahead." },
        ],
      },
    ];

    expect(recentConversationForJudge(history, "Yeah go ahead.")).toBe(
      "caller: hey\nassistant: Want me to email Priya the numbers?",
    );
  });

  test("skips tool traffic and caps the window", () => {
    const history: Message[] = [
      ...Array.from({ length: 10 }, (_, i) => text("user", `turn ${i}`)),
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "t1", name: "web_search", input: {} },
        ],
      },
    ];

    const lines = recentConversationForJudge(history, "next").split("\n");
    expect(lines).toHaveLength(6);
    expect(lines.at(-1)).toBe("caller: turn 9");
  });
});

describe("judgeEscalation", () => {
  const history = [text("assistant", "Hi, what can I do?")];

  test("escalates at or above the threshold and asks through the judge call site", async () => {
    let seen: { body: unknown; options?: SendMessageOptions } | null = null;
    const judgement = await judgeEscalation({
      conversationId: "conv-1",
      history,
      utterance: "Text my mom I'm late.",
      resolveProvider: async () =>
        fakeProvider(async (messages, options) => {
          const block = messages[0]!.content[0]!;
          seen = {
            body: JSON.parse(block.type === "text" ? block.text : ""),
            options,
          };
          return jevResponse(ESCALATION_JUDGE_THRESHOLD);
        }),
    });

    expect(judgement.escalate).toBe(true);
    expect(judgement.outcome).toBe("escalate");
    expect(judgement.noul).toBe(ESCALATION_JUDGE_THRESHOLD);
    const request = seen as unknown as {
      body: {
        state: { caller_just_said: string; recent_conversation: string };
        questions: { needs_escalation: { type: string } };
      };
      options: SendMessageOptions;
    };
    expect(request.body.state.caller_just_said).toBe("Text my mom I'm late.");
    expect(request.body.state.recent_conversation).toBe(
      "assistant: Hi, what can I do?",
    );
    expect(request.body.questions.needs_escalation.type).toBe("noul");
    expect(
      (request.options.config as { callSite?: string } | undefined)?.callSite,
    ).toBe(VOICE_ESCALATION_JUDGE_CALL_SITE);
  });

  test("clears below the threshold", async () => {
    const judgement = await judgeEscalation({
      conversationId: "conv-1",
      history,
      utterance: "Tell me a joke.",
      resolveProvider: async () => fakeProvider(async () => jevResponse(0.05)),
    });

    expect(judgement).toMatchObject({ escalate: false, outcome: "clear" });
  });

  test("is unavailable without a TypeSafe provider", async () => {
    const judgement = await judgeEscalation({
      conversationId: "conv-1",
      history,
      utterance: "Open Spotify.",
      resolveProvider: async () => null,
    });

    expect(judgement).toMatchObject({
      escalate: false,
      outcome: "unavailable",
    });
  });

  test("a provider error does not escalate", async () => {
    const judgement = await judgeEscalation({
      conversationId: "conv-1",
      history,
      utterance: "Open Spotify.",
      resolveProvider: async () =>
        fakeProvider(async () => {
          throw new Error("503");
        }),
    });

    expect(judgement).toMatchObject({ escalate: false, outcome: "error" });
  });

  test("an unparseable answer does not escalate", async () => {
    const judgement = await judgeEscalation({
      conversationId: "conv-1",
      history,
      utterance: "Open Spotify.",
      resolveProvider: async () =>
        fakeProvider(async () => ({
          ...jevResponse(0.9),
          content: [{ type: "text", text: "not json" }],
          rawResponse: {},
        })),
    });

    expect(judgement).toMatchObject({ escalate: false, outcome: "error" });
  });

  test("a provider that never answers times out without escalating", async () => {
    let aborted = false;
    const judgement = await judgeEscalation({
      conversationId: "conv-1",
      history,
      utterance: "Open Spotify.",
      timeoutMs: 20,
      resolveProvider: async () =>
        fakeProvider(async (_messages, options) => {
          options?.signal?.addEventListener("abort", () => {
            aborted = true;
          });
          return new Promise<ProviderResponse>(() => {});
        }),
    });

    expect(judgement).toMatchObject({ escalate: false, outcome: "timeout" });
    expect(aborted).toBe(true);
  });

  test("an empty utterance is not judged", async () => {
    let called = false;
    const judgement = await judgeEscalation({
      conversationId: "conv-1",
      history,
      utterance: "   ",
      resolveProvider: async () => {
        called = true;
        return null;
      },
    });

    expect(judgement.outcome).toBe("unavailable");
    expect(called).toBe(false);
  });
});
