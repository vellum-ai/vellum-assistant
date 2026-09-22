import { describe, expect, test } from "bun:test";

import type { ProfileEntry } from "../../config/schemas/llm.js";
import type {
  Message,
  Provider,
  ProviderResponse,
  SendMessageOptions,
} from "../../providers/types.js";
import {
  AUTO_PROFILE_FALLBACK,
  autoProfileCandidates,
  autoProfileFallback,
  recentConversationForRouter,
  routeAutoProfile,
} from "../auto-profile-router.js";

function text(role: "user" | "assistant", body: string): Message {
  return { role, content: [{ type: "text", text: body }] };
}

function jevResponse(answers: Record<string, unknown>): ProviderResponse {
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

const managed = (label: string, status?: "disabled"): ProfileEntry => ({
  source: "managed",
  provider: "vellum",
  model: "m",
  label,
  ...(status ? { status } : {}),
});

const profiles: Record<string, ProfileEntry> = {
  auto: managed("Auto"),
  balanced: managed("Balanced"),
  "quality-optimized": managed("Quality"),
  "cost-optimized": managed("Budget"),
  "latency-optimized": managed("Fast"),
};

const base = {
  conversationId: "conv-1",
  history: [text("user", "hi"), text("assistant", "hello")],
  userMessage: "Refactor the auth module and fix the race in token refresh",
  profiles,
};

describe("autoProfileCandidates", () => {
  test("offers the default profiles that exist and are not disabled", () => {
    expect(
      autoProfileCandidates({
        ...profiles,
        "cost-optimized": managed("Budget", "disabled"),
      }),
    ).toEqual(["balanced", "quality-optimized", "latency-optimized"]);
    expect(autoProfileCandidates({ balanced: managed("Balanced") })).toEqual([
      "balanced",
    ]);
  });
});

describe("recentConversationForRouter", () => {
  test("drops injected blocks and the current message, keeps roles", () => {
    const history: Message[] = [
      text("user", "hey"),
      { role: "user", content: [{ type: "text", text: "<memory>x</memory>" }] },
      text("assistant", "Hi there"),
      text("user", "do it"),
    ];
    expect(recentConversationForRouter(history, "do it")).toBe(
      "user: hey\nassistant: Hi there",
    );
  });
});

describe("routeAutoProfile", () => {
  test("pins the turn to Jev's choice and sends the candidates as criteria", async () => {
    let sent: unknown;
    const route = await routeAutoProfile({
      ...base,
      resolveProvider: async () =>
        fakeProvider(async (messages) => {
          const block = messages[0]?.content[0];
          sent = JSON.parse(block?.type === "text" ? block.text : "{}");
          return jevResponse({
            profile: {
              type: "choice",
              choice: "quality-optimized",
              confidence: 0.8,
              probabilities: { "quality-optimized": 0.85, balanced: 0.15 },
            },
          });
        }),
    });
    expect(route).toMatchObject({
      profile: "quality-optimized",
      outcome: "routed",
      confidence: 0.8,
    });
    const request = sent as {
      state: Record<string, string>;
      questions: {
        profile: { type: string; criteria: Record<string, string> };
      };
    };
    expect(request.state.latest_user_message).toBe(base.userMessage);
    expect(request.state.recent_conversation).toBe(
      "user: hi\nassistant: hello",
    );
    expect(request.questions.profile.type).toBe("choice");
    expect(Object.keys(request.questions.profile.criteria)).toEqual([
      "balanced",
      "quality-optimized",
      "cost-optimized",
      "latency-optimized",
    ]);
    expect(
      request.questions.profile.criteria.balanced.startsWith("Balanced: "),
    ).toBe(true);
  });

  test("falls back to Balanced when the choice names no candidate", async () => {
    const route = await routeAutoProfile({
      ...base,
      resolveProvider: async () =>
        fakeProvider(async () =>
          jevResponse({ profile: { type: "choice", choice: "auto" } }),
        ),
    });
    expect(route).toMatchObject({
      profile: AUTO_PROFILE_FALLBACK,
      outcome: "error",
    });
  });

  test("falls back to Balanced when no TypeSafe route resolves", async () => {
    const route = await routeAutoProfile({
      ...base,
      resolveProvider: async () => null,
    });
    expect(route).toEqual({
      profile: AUTO_PROFILE_FALLBACK,
      outcome: "unavailable",
      latencyMs: expect.any(Number),
    });
  });

  test("falls back to Balanced on timeout", async () => {
    const route = await routeAutoProfile({
      ...base,
      timeoutMs: 5,
      resolveProvider: async () =>
        fakeProvider(
          (_messages, options) =>
            new Promise((_resolve, reject) => {
              options?.signal?.addEventListener("abort", () =>
                reject(new Error("aborted")),
              );
            }),
        ),
    });
    expect(route.profile).toBe(AUTO_PROFILE_FALLBACK);
    expect(route.outcome).toBe("timeout");
  });

  test("does not ask when fewer than two candidates remain", async () => {
    let asked = false;
    const route = await routeAutoProfile({
      ...base,
      profiles: { auto: managed("Auto"), balanced: managed("Balanced") },
      resolveProvider: async () => {
        asked = true;
        return null;
      },
    });
    expect(asked).toBe(false);
    expect(route).toEqual({
      profile: AUTO_PROFILE_FALLBACK,
      outcome: "fallback",
      latencyMs: 0,
    });
  });

  test("falls back to an enabled candidate when Balanced is disabled", async () => {
    const withoutBalanced = {
      ...profiles,
      balanced: managed("Balanced", "disabled"),
    };
    expect(autoProfileFallback(autoProfileCandidates(withoutBalanced))).toBe(
      "quality-optimized",
    );
    const unavailable = await routeAutoProfile({
      ...base,
      profiles: withoutBalanced,
      resolveProvider: async () => null,
    });
    expect(unavailable.profile).toBe("quality-optimized");
    const single = await routeAutoProfile({
      ...base,
      profiles: {
        auto: managed("Auto"),
        balanced: managed("Balanced", "disabled"),
        "cost-optimized": managed("Budget"),
      },
    });
    expect(single).toMatchObject({
      profile: "cost-optimized",
      outcome: "fallback",
    });
    expect(autoProfileFallback([])).toBe(AUTO_PROFILE_FALLBACK);
  });
});
