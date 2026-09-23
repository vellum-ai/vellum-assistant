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
  AUTO_PROFILE_PREVIEW_REUSE_MS,
  autoProfileCandidates,
  autoProfileFallback,
  autoProfilePreviewContext,
  type AutoProfileRoute,
  clearAutoProfilePreviewsForTesting,
  recentConversationForRouter,
  rememberAutoProfilePreview,
  routeAutoProfile,
  takeAutoProfilePreview,
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

const contextFor = (
  history: readonly Message[],
  userMessage: string,
  candidatesFrom: Record<string, ProfileEntry>,
) =>
  autoProfilePreviewContext(
    history,
    userMessage,
    autoProfileCandidates(candidatesFrom),
  );

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

describe("draft preview reuse", () => {
  const routed: AutoProfileRoute = {
    profile: "quality-optimized",
    outcome: "routed",
    confidence: 0.9,
    latencyMs: 120,
  };
  const history = [text("user", "hi"), text("assistant", "hello")];
  const context = (h: Message[] = history) =>
    contextFor(h, "Refactor the auth module", profiles);
  const take = (
    overrides: Partial<Parameters<typeof takeAutoProfilePreview>[0]> = {},
  ) =>
    takeAutoProfilePreview({
      conversationId: "conv-1",
      text: "Refactor the auth module",
      history,
      profiles,
      ...overrides,
    });

  test("a routed preview is reused once by the turn that sends the same text", () => {
    clearAutoProfilePreviewsForTesting();
    rememberAutoProfilePreview(
      "conv-1",
      "Refactor  the auth\nmodule",
      routed,
      context(),
    );
    expect(take()).toEqual(routed);
    expect(take()).toBeUndefined();
  });

  test("a different draft, another conversation, or an expired preview is not reused", () => {
    clearAutoProfilePreviewsForTesting();
    const at = Date.now();
    rememberAutoProfilePreview("conv-1", "hello", routed, context(), at);
    expect(take({ text: "hello there" })).toBeUndefined();
    expect(take({ text: "hello", conversationId: "conv-2" })).toBeUndefined();
    expect(
      take({ text: "hello", now: at + AUTO_PROFILE_PREVIEW_REUSE_MS + 1 }),
    ).toBeUndefined();
  });

  test("a preview is not reused once the conversation or the candidates moved on", () => {
    clearAutoProfilePreviewsForTesting();
    rememberAutoProfilePreview("conv-1", "do that too", routed, context());
    expect(
      take({
        text: "do that too",
        history: [...history, text("assistant", "Anything else?")],
      }),
    ).toBeUndefined();
    rememberAutoProfilePreview("conv-1", "do that too", routed, context());
    expect(
      take({
        text: "do that too",
        profiles: {
          ...profiles,
          "cost-optimized": managed("Budget", "disabled"),
        },
      }),
    ).toBeUndefined();
  });

  test("a preview made before the conversation existed fits only a turn with no history", () => {
    clearAutoProfilePreviewsForTesting();
    rememberAutoProfilePreview(
      undefined,
      "first message",
      routed,
      contextFor([], "first message", profiles),
    );
    expect(
      take({ conversationId: "conv-old", text: "first message" }),
    ).toBeUndefined();
    expect(
      take({ conversationId: "conv-new", text: "first message", history: [] }),
    ).toEqual(routed);
  });

  test("a fallback is not remembered, so the turn asks Jev again", () => {
    clearAutoProfilePreviewsForTesting();
    rememberAutoProfilePreview(
      "conv-1",
      "hi",
      { profile: AUTO_PROFILE_FALLBACK, outcome: "timeout", latencyMs: 1000 },
      contextFor(history, "hi", profiles),
    );
    expect(take({ text: "hi" })).toBeUndefined();
  });

  test("abandoned previews expire and the map stays bounded", () => {
    clearAutoProfilePreviewsForTesting();
    const at = Date.now();
    rememberAutoProfilePreview(
      "conv-stale",
      "old draft",
      routed,
      context(),
      at,
    );
    for (let i = 0; i < 250; i += 1) {
      rememberAutoProfilePreview(
        `conv-${i}`,
        "draft",
        routed,
        context(),
        at + AUTO_PROFILE_PREVIEW_REUSE_MS + 1,
      );
    }
    expect(
      take({
        conversationId: "conv-stale",
        text: "old draft",
        now: at + AUTO_PROFILE_PREVIEW_REUSE_MS + 2,
      }),
    ).toBeUndefined();
    expect(
      take({
        conversationId: "conv-0",
        text: "draft",
        now: at + AUTO_PROFILE_PREVIEW_REUSE_MS + 2,
      }),
    ).toBeUndefined();
    expect(
      take({
        conversationId: "conv-249",
        text: "draft",
        now: at + AUTO_PROFILE_PREVIEW_REUSE_MS + 2,
      }),
    ).toEqual(routed);
  });
});
