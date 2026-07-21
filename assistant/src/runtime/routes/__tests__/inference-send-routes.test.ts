/**
 * Handler tests for the `inference_send` route's runtime-observed evidence.
 *
 * The route surfaces `evidence.resolved_endpoint` so callers (e.g. Doctor's
 * `probe_symptom`) can confirm the endpoint the inference client actually
 * resolved to. The field is threaded straight from
 * `ProviderResponse.resolvedEndpoint` and must be omitted — not guessed —
 * when the provider does not surface one.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import { LLMSchema } from "../../../config/schemas/llm.js";
import type { ConfiguredProviderOptions } from "../../../providers/provider-send-message.js";
import type {
  ProviderResponse,
  SendMessageOptions,
} from "../../../providers/types.js";

// ---------------------------------------------------------------------------
// Mock: the handler resolves a provider and sends one message. We stub the
// provider layer so no real LLM call is made and the returned
// ProviderResponse (including resolvedEndpoint) is fully controlled.
// ---------------------------------------------------------------------------

let nextResponse: ProviderResponse;
let getConfiguredProviderOptions: ConfiguredProviderOptions | undefined;
let sendMessageOptions: SendMessageOptions | undefined;

mock.module("../../../providers/provider-send-message.js", () => ({
  getConfiguredProvider: async (
    _callSite: string,
    options: ConfiguredProviderOptions,
  ) => {
    getConfiguredProviderOptions = options;
    return {
      name: "stub",
      sendMessage: async (_messages: unknown, options: SendMessageOptions) => {
        sendMessageOptions = options;
        return nextResponse;
      },
    };
  },
  extractAllText: (response: ProviderResponse) =>
    response.content.map((b) => (b.type === "text" ? b.text : "")).join(""),
  userMessage: (text: string) => ({
    role: "user",
    content: [{ type: "text", text }],
  }),
}));

// The route reads `llm` for the profile checks only; drive it from the test so
// a case can present an unusable profile without touching the workspace config.
let configuredLlm = LLMSchema.parse({});
mock.module("../../../config/loader.js", () => ({
  getConfigReadOnly: () => ({ llm: configuredLlm }),
  getConfig: () => ({ llm: configuredLlm }),
}));

const { ROUTES } = await import("../inference-send-routes.js");
const { BadRequestError } = await import("../errors.js");

function inferenceSendHandler() {
  const route = ROUTES.find((r) => r.operationId === "inference_send");
  if (!route) {
    throw new Error("inference_send route not registered");
  }
  return route.handler;
}

function baseResponse(overrides: Partial<ProviderResponse>): ProviderResponse {
  return {
    content: [{ type: "text", text: "hello" }],
    model: "test-model",
    usage: { inputTokens: 1, outputTokens: 2 },
    stopReason: "stop",
    ...overrides,
  };
}

beforeEach(() => {
  configuredLlm = LLMSchema.parse({});
  nextResponse = baseResponse({});
  getConfiguredProviderOptions = undefined;
  sendMessageOptions = undefined;
});

describe("inference_send profile routing", () => {
  test("forwards the requested profile and one selection seed through both resolution stages", async () => {
    const requestedProfile = "quality-optimized";

    await inferenceSendHandler()({
      body: { message: "hi", profile: requestedProfile },
    });

    expect(getConfiguredProviderOptions?.overrideProfile).toBe(
      requestedProfile,
    );
    expect(sendMessageOptions?.config?.overrideProfile).toBe(requestedProfile);
    expect(getConfiguredProviderOptions?.selectionSeed).toEqual(
      expect.any(String),
    );
    expect(sendMessageOptions?.config?.selectionSeed).toBe(
      getConfiguredProviderOptions?.selectionSeed,
    );
  });
});

describe("inference_send evidence", () => {
  test("surfaces resolved_endpoint observed from the provider response", async () => {
    // GIVEN a provider whose runtime response reports the resolved endpoint
    nextResponse = baseResponse({
      resolvedEndpoint: "https://inference.example.test/v1",
    });

    // WHEN the inference_send handler processes a request
    const result = (await inferenceSendHandler()({
      body: { message: "hi" },
    })) as {
      response: string;
      model: string;
      evidence?: { resolved_endpoint?: string };
    };

    // THEN the response echoes the model text
    expect(result.response).toBe("hello");

    // AND the observed endpoint is exposed under evidence.resolved_endpoint
    expect(result.evidence).toEqual({
      resolved_endpoint: "https://inference.example.test/v1",
    });
  });

  test("omits evidence entirely when the provider surfaces no endpoint", async () => {
    // GIVEN a provider whose runtime response carries no resolvedEndpoint
    nextResponse = baseResponse({ resolvedEndpoint: undefined });

    // WHEN the inference_send handler processes a request
    const result = (await inferenceSendHandler()({
      body: { message: "hi" },
    })) as { evidence?: { resolved_endpoint?: string } };

    // THEN no evidence object is fabricated — the endpoint stays unknown
    expect(result.evidence).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Existence in `llm.profiles` is weaker than usability: the resolver also
// requires the entry to be enabled and to carry its own provider + model, and
// silently falls through to this call site's `cost-optimized` default when it
// does not. The route must reject rather than answer from that other model.
// ---------------------------------------------------------------------------

describe("inference_send profile usability", () => {
  const hermes = {
    provider: "openrouter",
    model: "nousresearch/hermes-3-llama-3.1-405b",
    source: "user",
  };

  function rejection(entry: Record<string, unknown>): Promise<Error> {
    configuredLlm = LLMSchema.parse({ profiles: { "hermes-405b": entry } });
    return Promise.resolve(
      inferenceSendHandler()({
        body: { message: "hi", profile: "hermes-405b" },
      }),
    ).then(
      () => new Error("expected the request to be rejected"),
      (err: Error) => err,
    );
  }

  test("rejects a disabled profile instead of running the managed default", async () => {
    const err = await rejection({ ...hermes, status: "disabled" });
    expect(err).toBeInstanceOf(BadRequestError);
    expect(err.message).toContain("disabled");
    expect(err.message).toContain("deepseek-v4-flash");
  });

  test("rejects a profile that lost its provider", async () => {
    const err = await rejection({ model: hermes.model, source: "user" });
    expect(err).toBeInstanceOf(BadRequestError);
    expect(err.message).toContain("incomplete");
  });
});
