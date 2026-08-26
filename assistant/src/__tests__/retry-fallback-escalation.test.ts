import { beforeEach, describe, expect, mock, test } from "bun:test";

import * as retryUtil from "../util/retry.js";

// Instant sleep so exhausted-retry cases don't wait out real backoff delays;
// everything else is the real module.
mock.module("../util/retry.js", () => ({
  ...retryUtil,
  sleep: async () => {},
}));

import {
  recordFallbackServed,
  resetFallbackBreaker,
} from "../providers/fallback-breaker.js";
import type {
  Message,
  Provider,
  ProviderResponse,
  SendMessageOptions,
} from "../providers/types.js";
import { setConfig } from "./helpers/set-config.js";

const { RetryProvider } = await import("../providers/retry.js");
const { ContextOverflowError } = await import("../providers/types.js");
const { ProviderError } = await import("../util/errors.js");
const { DEFAULT_MAX_RETRIES } = await import("../util/retry.js");

// ── Fixtures ────────────────────────────────────────────────────────────────

const MESSAGES: Message[] = [
  { role: "user", content: [{ type: "text", text: "hi" }] },
];

// Primary route resolves through the active profile; the fallback forces the
// backup profile via `overrideProfile` + `forceOverrideProfile`, so the
// backup's model/maxTokens must win on the re-normalized options.
const LLM_FIXTURE = {
  profiles: {
    "primary-profile": {
      source: "user",
      provider: "openai",
      model: "primary-model",
      maxTokens: 1111,
    },
    "backup-profile": {
      source: "user",
      provider: "anthropic",
      model: "backup-model",
      maxTokens: 2222,
    },
  },
  activeProfile: "primary-profile",
};

beforeEach(() => {
  setConfig("llm", LLM_FIXTURE);
  // The circuit breaker remembers a served fallback for the whole process, so
  // a case that escalates would otherwise make the next case skip its primary.
  resetFallbackBreaker();
});

function okResponse(model: string): ProviderResponse {
  return {
    content: [{ type: "text", text: "ok" }],
    model,
    usage: { inputTokens: 1, outputTokens: 1 },
    stopReason: "end_turn",
  } as ProviderResponse;
}

/** Primary stub that always throws `makeError()`. */
function failingProvider(
  name: string,
  makeError: () => unknown,
): { provider: Provider; calls: () => number } {
  let calls = 0;
  const provider: Provider = {
    name,
    sendMessage: async () => {
      calls += 1;
      throw makeError();
    },
  };
  return { provider, calls: () => calls };
}

/** Backup stub that records the options it was sent and serves a response. */
function backupProvider(
  name = "anthropic",
  opts: { supportsNativeWebSearch?: boolean } = {},
): {
  provider: Provider;
  calls: () => number;
  seenConfig: () => Record<string, unknown>;
  seenToolNames: () => string[];
} {
  let calls = 0;
  let seen: SendMessageOptions | undefined;
  const provider: Provider = {
    name,
    ...(opts.supportsNativeWebSearch === undefined
      ? {}
      : { supportsNativeWebSearch: opts.supportsNativeWebSearch }),
    sendMessage: async (_messages: Message[], options?: SendMessageOptions) => {
      calls += 1;
      seen = options;
      const config = options?.config as Record<string, unknown> | undefined;
      return okResponse((config?.model as string | undefined) ?? "unresolved");
    },
  };
  return {
    provider,
    calls: () => calls,
    seenConfig: () => (seen?.config ?? {}) as Record<string, unknown>,
    seenToolNames: () => (seen?.tools ?? []).map((tool) => tool.name),
  };
}

function makeRoute(
  provider: Provider,
  {
    overrideProfile = "backup-profile",
    forwardUsageAttributionHeaders = true,
  }: {
    overrideProfile?: string;
    forwardUsageAttributionHeaders?: boolean;
  } = {},
): {
  resolveFallbackRoute: (
    failedOptions: SendMessageOptions | undefined,
  ) => Promise<{
    provider: Provider;
    overrideProfile: string;
    forwardUsageAttributionHeaders: boolean;
  } | null>;
  calls: () => number;
} {
  let calls = 0;
  return {
    resolveFallbackRoute: async () => {
      calls += 1;
      return { provider, overrideProfile, forwardUsageAttributionHeaders };
    },
    calls: () => calls,
  };
}

async function captureError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the promise to reject");
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("RetryProvider fallback-route escalation", () => {
  test("retries exhaust on 503 → callback invoked once, backup serves, headers restamped", async () => {
    const primary = failingProvider(
      "openai",
      () => new ProviderError("Service Unavailable", "openai", 503),
    );
    const backup = backupProvider();
    const route = makeRoute(backup.provider);
    const wrapped = new RetryProvider(primary.provider, {
      forwardUsageAttributionHeaders: true,
      resolveFallbackRoute: route.resolveFallbackRoute,
    });

    const result = await wrapped.sendMessage(MESSAGES, {
      config: { callSite: "mainAgent" },
    });

    // Full retry budget burned on the primary before escalating.
    expect(primary.calls()).toBe(1 + DEFAULT_MAX_RETRIES);
    expect(route.calls()).toBe(1);
    expect(backup.calls()).toBe(1);
    expect(result.model).toBe("backup-model");

    // The re-normalized options carry the backup profile's resolved values...
    const config = backup.seenConfig();
    expect(config.model).toBe("backup-model");
    expect(config.max_tokens).toBe(2222);
    // ...with routing keys stripped before the fallback provider sees them.
    expect(config.callSite).toBeUndefined();
    expect(config.overrideProfile).toBeUndefined();
    expect(config.forceOverrideProfile).toBeUndefined();
    // Usage-attribution headers come from the backup resolution so platform
    // usage events attribute degraded traffic to the backup profile.
    const headers = config.usageAttributionHeaders as Record<string, string>;
    expect(headers["X-Vellum-Inference-Profile"]).toBe("backup-profile");
    expect(headers["X-Vellum-Resolved-Model"]).toBe("backup-model");
    expect(headers["X-Vellum-Resolved-Provider"]).toBe("anthropic");
  });

  test("401 invalid_credentials after refresh fails → falls back without burning the retry budget", async () => {
    const primary = failingProvider(
      "openai",
      () =>
        new ProviderError("Unauthorized", "openai", 401, {
          reason: "invalid_credentials",
        }),
    );
    const backup = backupProvider();
    const route = makeRoute(backup.provider);
    let refreshCalls = 0;
    const wrapped = new RetryProvider(primary.provider, {
      credentialSource: "vellum-managed",
      refreshCredentialProvider: async () => {
        refreshCalls += 1;
        return null;
      },
      resolveFallbackRoute: route.resolveFallbackRoute,
    });

    const result = await wrapped.sendMessage(MESSAGES, {
      config: { callSite: "mainAgent" },
    });

    // The existing credential-refresh path ran first; the 401 is
    // non-retryable, so the primary was attempted exactly once.
    expect(refreshCalls).toBe(1);
    expect(primary.calls()).toBe(1);
    expect(route.calls()).toBe(1);
    expect(result.model).toBe("backup-model");
  });

  test.each(["byok", "oauth-subscription", "no-auth", undefined] as const)(
    "401 invalid_credentials on a %s route → callback never invoked, auth error surfaces",
    async (credentialSource) => {
      // The credential eligibility case is restricted to `vellum-managed`
      // routes. A broken personal credential must surface so the user can
      // fix it, not silently reroute to a differently billed backup.
      const authError = new ProviderError("Unauthorized", "openai", 401, {
        reason: "invalid_credentials",
      });
      const primary = failingProvider("openai", () => authError);
      const route = makeRoute(backupProvider().provider);
      const wrapped = new RetryProvider(primary.provider, {
        ...(credentialSource !== undefined ? { credentialSource } : {}),
        resolveFallbackRoute: route.resolveFallbackRoute,
      });

      const thrown = await captureError(
        wrapped.sendMessage(MESSAGES, { config: { callSite: "mainAgent" } }),
      );

      expect(thrown).toBe(authError);
      expect(primary.calls()).toBe(1);
      expect(route.calls()).toBe(0);
    },
  );

  test("404 model-not-found (non-retryable) → falls back immediately", async () => {
    const primary = failingProvider(
      "openai",
      () => new ProviderError("model not found", "openai", 404),
    );
    const backup = backupProvider();
    const route = makeRoute(backup.provider);
    const wrapped = new RetryProvider(primary.provider, {
      resolveFallbackRoute: route.resolveFallbackRoute,
    });

    const result = await wrapped.sendMessage(MESSAGES, {
      config: { callSite: "mainAgent" },
    });

    expect(primary.calls()).toBe(1);
    expect(route.calls()).toBe(1);
    expect(result.model).toBe("backup-model");
  });

  test.each(["unknown", undefined] as const)(
    "404 with reason %s → status fallback applies, backup serves",
    async (reason) => {
      const primary = failingProvider(
        "openai",
        () =>
          new ProviderError("not found", "openai", 404, {
            ...(reason !== undefined ? { reason } : {}),
          }),
      );
      const backup = backupProvider();
      const route = makeRoute(backup.provider);
      const wrapped = new RetryProvider(primary.provider, {
        resolveFallbackRoute: route.resolveFallbackRoute,
      });

      const result = await wrapped.sendMessage(MESSAGES, {
        config: { callSite: "mainAgent" },
      });

      expect(route.calls()).toBe(1);
      expect(result.model).toBe("backup-model");
    },
  );

  test("404 with provider-classified reason model_not_found → falls back immediately", async () => {
    const primary = failingProvider(
      "openai",
      () =>
        new ProviderError("model not found", "openai", 404, {
          reason: "model_not_found",
        }),
    );
    const backup = backupProvider();
    const route = makeRoute(backup.provider);
    const wrapped = new RetryProvider(primary.provider, {
      resolveFallbackRoute: route.resolveFallbackRoute,
    });

    const result = await wrapped.sendMessage(MESSAGES, {
      config: { callSite: "mainAgent" },
    });

    expect(primary.calls()).toBe(1);
    expect(route.calls()).toBe(1);
    expect(result.model).toBe("backup-model");
  });

  test("404 with a definitive non-model reason (bad_request) → callback never invoked", async () => {
    // Anthropic classifies a 404 without a model signal as `bad_request`: a
    // missing gateway resource or other deterministic request failure. The
    // provider-stamped semantic reason takes precedence over the raw status,
    // so the request must surface its real error instead of switching routes.
    const requestError = new ProviderError("not found", "anthropic", 404, {
      reason: "bad_request",
    });
    const primary = failingProvider("anthropic", () => requestError);
    const route = makeRoute(backupProvider().provider);
    const wrapped = new RetryProvider(primary.provider, {
      resolveFallbackRoute: route.resolveFallbackRoute,
    });

    const thrown = await captureError(
      wrapped.sendMessage(MESSAGES, { config: { callSite: "mainAgent" } }),
    );

    expect(thrown).toBe(requestError);
    expect(primary.calls()).toBe(1);
    expect(route.calls()).toBe(0);
  });

  test("managed proxy preflight 400 for a retired model → falls back immediately", async () => {
    const primary = failingProvider(
      "openai",
      () =>
        new ProviderError(
          "Model 'gpt-old' is not yet supported on the Vellum hosted service.",
          "openai",
          400,
        ),
    );
    const backup = backupProvider();
    const route = makeRoute(backup.provider);
    const wrapped = new RetryProvider(primary.provider, {
      resolveFallbackRoute: route.resolveFallbackRoute,
    });

    const result = await wrapped.sendMessage(MESSAGES, {
      config: { callSite: "mainAgent" },
    });

    expect(primary.calls()).toBe(1);
    expect(route.calls()).toBe(1);
    expect(result.model).toBe("backup-model");
  });

  test("plain 400 (request problem) → callback never invoked", async () => {
    const primary = failingProvider(
      "openai",
      () => new ProviderError("invalid request", "openai", 400),
    );
    const route = makeRoute(backupProvider().provider);
    const wrapped = new RetryProvider(primary.provider, {
      resolveFallbackRoute: route.resolveFallbackRoute,
    });

    const thrown = await captureError(
      wrapped.sendMessage(MESSAGES, { config: { callSite: "mainAgent" } }),
    );

    expect((thrown as InstanceType<typeof ProviderError>).statusCode).toBe(400);
    expect(route.calls()).toBe(0);
  });

  test("context overflow → callback never invoked", async () => {
    const primary = failingProvider(
      "openai",
      () => new ContextOverflowError("prompt too long", "openai"),
    );
    const route = makeRoute(backupProvider().provider);
    const wrapped = new RetryProvider(primary.provider, {
      resolveFallbackRoute: route.resolveFallbackRoute,
    });

    const thrown = await captureError(
      wrapped.sendMessage(MESSAGES, { config: { callSite: "mainAgent" } }),
    );

    expect(thrown).toBeInstanceOf(ContextOverflowError);
    expect(primary.calls()).toBe(1);
    expect(route.calls()).toBe(0);
  });

  test("caller abort → callback never invoked", async () => {
    const primary = failingProvider(
      "openai",
      () =>
        new ProviderError("Request was aborted.", "openai", undefined, {
          abortReason: "user_cancelled",
        }),
    );
    const route = makeRoute(backupProvider().provider);
    const wrapped = new RetryProvider(primary.provider, {
      resolveFallbackRoute: route.resolveFallbackRoute,
    });

    const thrown = await captureError(
      wrapped.sendMessage(MESSAGES, { config: { callSite: "mainAgent" } }),
    );

    expect((thrown as InstanceType<typeof ProviderError>).abortReason).toBe(
      "user_cancelled",
    );
    expect(primary.calls()).toBe(1);
    expect(route.calls()).toBe(0);
  });

  test.each([
    ["model", "pinned-model"],
    ["provider", "openai"],
    ["provider_connection", "vellum"],
  ] as const)(
    "explicit config.%s pin + outage-shaped error → callback never invoked, original error rethrown",
    async (field, value) => {
      const finalError = new ProviderError(
        "Service Unavailable",
        "openai",
        503,
      );
      const primary = failingProvider("openai", () => finalError);
      const route = makeRoute(backupProvider().provider);
      const wrapped = new RetryProvider(primary.provider, {
        resolveFallbackRoute: route.resolveFallbackRoute,
      });

      const thrown = await captureError(
        wrapped.sendMessage(MESSAGES, {
          config: { callSite: "mainAgent", [field]: value },
        }),
      );

      expect(thrown).toBe(finalError);
      expect(route.calls()).toBe(0);
      expect((thrown as { retriesExhausted?: boolean }).retriesExhausted).toBe(
        true,
      );
    },
  );

  test.each([
    ["model", "pinned-model"],
    ["provider", "openai"],
  ] as const)(
    "persisted call-site %s pin + outage-shaped error → callback never invoked",
    async (field, value) => {
      setConfig("llm", {
        ...LLM_FIXTURE,
        callSites: { mainAgent: { [field]: value } },
      });
      const finalError = new ProviderError(
        "Service Unavailable",
        "openai",
        503,
      );
      const primary = failingProvider("openai", () => finalError);
      const route = makeRoute(backupProvider().provider);
      const wrapped = new RetryProvider(primary.provider, {
        resolveFallbackRoute: route.resolveFallbackRoute,
      });

      const thrown = await captureError(
        wrapped.sendMessage(MESSAGES, { config: { callSite: "mainAgent" } }),
      );

      expect(thrown).toBe(finalError);
      expect(route.calls()).toBe(0);
    },
  );

  test("callback returns null (no fallbackProfile) → original error rethrown with retriesExhausted tagging", async () => {
    const finalError = new ProviderError("Service Unavailable", "openai", 503);
    const primary = failingProvider("openai", () => finalError);
    let routeCalls = 0;
    const wrapped = new RetryProvider(primary.provider, {
      resolveFallbackRoute: async () => {
        routeCalls += 1;
        return null;
      },
    });

    const thrown = await captureError(
      wrapped.sendMessage(MESSAGES, { config: { callSite: "mainAgent" } }),
    );

    expect(routeCalls).toBe(1);
    expect(thrown).toBe(finalError);
    expect((thrown as { retriesExhausted?: boolean }).retriesExhausted).toBe(
      true,
    );
  });

  test("route returned for a disabled backup profile → no send on the backup adapter, original error rethrown", async () => {
    // A disabled override profile is skipped by winner selection, which
    // would resolve back to the primary profile while the request still
    // dispatches on the backup adapter (provider/model mismatch). The guard
    // must refuse the fallback send and surface the original error.
    setConfig("llm", {
      ...LLM_FIXTURE,
      profiles: {
        ...LLM_FIXTURE.profiles,
        "backup-profile": {
          ...LLM_FIXTURE.profiles["backup-profile"],
          status: "disabled",
        },
      },
    });
    const originalError = new ProviderError("model not found", "openai", 404);
    const primary = failingProvider("openai", () => originalError);
    const backup = backupProvider();
    const route = makeRoute(backup.provider);
    const wrapped = new RetryProvider(primary.provider, {
      resolveFallbackRoute: route.resolveFallbackRoute,
    });

    const thrown = await captureError(
      wrapped.sendMessage(MESSAGES, { config: { callSite: "mainAgent" } }),
    );

    expect(thrown).toBe(originalError);
    expect(route.calls()).toBe(1);
    expect(backup.calls()).toBe(0);
  });

  test("route returned for an incomplete backup profile (no model) → no send on the backup adapter, original error rethrown", async () => {
    setConfig("llm", {
      ...LLM_FIXTURE,
      profiles: {
        ...LLM_FIXTURE.profiles,
        "backup-profile": {
          source: "user",
          provider: "anthropic",
        },
      },
    });
    const originalError = new ProviderError("model not found", "openai", 404);
    const primary = failingProvider("openai", () => originalError);
    const backup = backupProvider();
    const route = makeRoute(backup.provider);
    const wrapped = new RetryProvider(primary.provider, {
      resolveFallbackRoute: route.resolveFallbackRoute,
    });

    const thrown = await captureError(
      wrapped.sendMessage(MESSAGES, { config: { callSite: "mainAgent" } }),
    );

    expect(thrown).toBe(originalError);
    expect(route.calls()).toBe(1);
    expect(backup.calls()).toBe(0);
  });

  test("route returned for a mix backup profile → no send on the backup adapter, original error rethrown", async () => {
    // The fallback schema forbids `fallbackProfile` from referencing a mix,
    // and RetryProvider must not trust that: a mix backup without a
    // `selectionSeed` would be re-expanded independently by the apply guard,
    // the route callback, and the normalization, potentially sending one
    // arm's model through another arm's provider adapter.
    setConfig("llm", {
      profiles: {
        ...LLM_FIXTURE.profiles,
        "arm-a": {
          source: "user",
          provider: "anthropic",
          model: "arm-a-model",
        },
        "arm-b": {
          source: "user",
          provider: "openai",
          model: "arm-b-model",
        },
        "backup-mix": {
          source: "user",
          mix: [
            { profile: "arm-a", weight: 1 },
            { profile: "arm-b", weight: 1 },
          ],
        },
      },
      activeProfile: "primary-profile",
    });
    const originalError = new ProviderError("model not found", "openai", 404);
    const primary = failingProvider("openai", () => originalError);
    const backup = backupProvider();
    const route = makeRoute(backup.provider, { overrideProfile: "backup-mix" });
    const wrapped = new RetryProvider(primary.provider, {
      resolveFallbackRoute: route.resolveFallbackRoute,
    });

    const thrown = await captureError(
      wrapped.sendMessage(MESSAGES, { config: { callSite: "mainAgent" } }),
    );

    expect(thrown).toBe(originalError);
    expect(route.calls()).toBe(1);
    expect(backup.calls()).toBe(0);
  });

  test("backup also fails → original error is preserved, no second fallback attempt", async () => {
    const originalError = new ProviderError("model not found", "openai", 404);
    const primary = failingProvider("openai", () => originalError);
    const fallbackError = new ProviderError("backup down", "anthropic", 500);
    const backup = failingProvider("anthropic", () => fallbackError);
    const route = makeRoute(backup.provider);
    const wrapped = new RetryProvider(primary.provider, {
      resolveFallbackRoute: route.resolveFallbackRoute,
    });

    const thrown = await captureError(
      wrapped.sendMessage(MESSAGES, { config: { callSite: "mainAgent" } }),
    );

    expect(thrown).toBe(originalError);
    expect((thrown as Error).cause).toBeUndefined();
    expect(route.calls()).toBe(1);
    expect(backup.calls()).toBe(1);
  });

  test("failed recovery probe and backup surface the probe error without retrying the primary", async () => {
    const originalError = new ProviderError(
      "Service Unavailable",
      "openai",
      503,
    );
    const primary = failingProvider("openai", () => originalError);
    const backupError = new ProviderError("invalid request", "anthropic", 400);
    const backup = failingProvider("anthropic", () => backupError);
    const route = makeRoute(backup.provider);
    const wrapped = new RetryProvider(primary.provider, {
      resolveFallbackRoute: route.resolveFallbackRoute,
    });
    recordFallbackServed({ upstream: "openai" }, Date.now() - 11 * 60_000);

    const thrown = await captureError(
      wrapped.sendMessage(MESSAGES, { config: { callSite: "mainAgent" } }),
    );

    expect(thrown).toBe(originalError);
    expect(primary.calls()).toBe(1);
    expect(route.calls()).toBe(1);
    expect(backup.calls()).toBe(1);
  });

  test("resolveFallbackRoute unset → behavior unchanged (original error rethrown)", async () => {
    const finalError = new ProviderError("Service Unavailable", "openai", 503);
    const primary = failingProvider("openai", () => finalError);
    const wrapped = new RetryProvider(primary.provider);

    const thrown = await captureError(
      wrapped.sendMessage(MESSAGES, { config: { callSite: "mainAgent" } }),
    );

    expect(thrown).toBe(finalError);
    expect(primary.calls()).toBe(1 + DEFAULT_MAX_RETRIES);
  });

  test("explicit max_tokens/effort/thinking are cleared so the backup profile's values win", async () => {
    const primary = failingProvider(
      "openai",
      () => new ProviderError("model not found", "openai", 404),
    );
    const backup = backupProvider();
    const route = makeRoute(backup.provider);
    const wrapped = new RetryProvider(primary.provider, {
      resolveFallbackRoute: route.resolveFallbackRoute,
    });

    await wrapped.sendMessage(MESSAGES, {
      config: {
        callSite: "mainAgent",
        max_tokens: 42,
        effort: "low",
        thinking: { type: "disabled" },
      },
    });

    const config = backup.seenConfig();
    expect(config.model).toBe("backup-model");
    // The explicit per-call cap was cleared; the backup profile's resolved
    // maxTokens applies instead.
    expect(config.max_tokens).toBe(2222);
    expect(config.effort).not.toBe("low");
  });

  test("route with forwardUsageAttributionHeaders false → no X-Vellum-* headers reach the backup adapter, even when the primary forwards them", async () => {
    // A managed primary (forwarding enabled) falling back to a BYOK or other
    // third-party adapter must not leak billing metadata: the fallback
    // normalization follows the ROUTE's policy, not the primary's.
    const primary = failingProvider(
      "openai",
      () => new ProviderError("model not found", "openai", 404),
    );
    const backup = backupProvider();
    const route = makeRoute(backup.provider, {
      forwardUsageAttributionHeaders: false,
    });
    const wrapped = new RetryProvider(primary.provider, {
      forwardUsageAttributionHeaders: true,
      resolveFallbackRoute: route.resolveFallbackRoute,
    });

    const result = await wrapped.sendMessage(MESSAGES, {
      config: { callSite: "mainAgent" },
    });

    expect(result.model).toBe("backup-model");
    expect(backup.seenConfig().usageAttributionHeaders).toBeUndefined();
  });

  test("route with forwardUsageAttributionHeaders true → headers present and reflect the backup profile, even when the primary does not forward them", async () => {
    // A non-managed primary (forwarding disabled) falling back to the
    // managed proxy must include the required attribution headers.
    const primary = failingProvider(
      "openai",
      () => new ProviderError("model not found", "openai", 404),
    );
    const backup = backupProvider();
    const route = makeRoute(backup.provider, {
      forwardUsageAttributionHeaders: true,
    });
    const wrapped = new RetryProvider(primary.provider, {
      forwardUsageAttributionHeaders: false,
      resolveFallbackRoute: route.resolveFallbackRoute,
    });

    const result = await wrapped.sendMessage(MESSAGES, {
      config: { callSite: "mainAgent" },
    });

    expect(result.model).toBe("backup-model");
    const headers = backup.seenConfig().usageAttributionHeaders as Record<
      string,
      string
    >;
    expect(headers["X-Vellum-Inference-Profile"]).toBe("backup-profile");
    expect(headers["X-Vellum-Resolved-Model"]).toBe("backup-model");
    expect(headers["X-Vellum-Resolved-Provider"]).toBe("anthropic");
  });

  test("fallback response without actualProvider → stamped with the backup provider's name", async () => {
    // The outer call-site router attributes success by `actualProvider`;
    // without the stamp it would record the fallback under the failed
    // primary provider and apply the wrong pricing.
    const primary = failingProvider(
      "openai",
      () => new ProviderError("model not found", "openai", 404),
    );
    const backup = backupProvider();
    const route = makeRoute(backup.provider);
    const wrapped = new RetryProvider(primary.provider, {
      resolveFallbackRoute: route.resolveFallbackRoute,
    });

    const result = await wrapped.sendMessage(MESSAGES, {
      config: { callSite: "mainAgent" },
    });

    expect(result.actualProvider).toBe("anthropic");
  });

  test("fallback response with adapter-set actualProvider → preserved, not overwritten", async () => {
    const primary = failingProvider(
      "openai",
      () => new ProviderError("model not found", "openai", 404),
    );
    const backup: Provider = {
      name: "anthropic",
      sendMessage: async () => ({
        ...okResponse("backup-model"),
        actualProvider: "openrouter/anthropic",
      }),
    };
    const route = makeRoute(backup);
    const wrapped = new RetryProvider(primary.provider, {
      resolveFallbackRoute: route.resolveFallbackRoute,
    });

    const result = await wrapped.sendMessage(MESSAGES, {
      config: { callSite: "mainAgent" },
    });

    expect(result.actualProvider).toBe("openrouter/anthropic");
  });

  test("fallback response → stamped with the backup profile key so usage tracking attributes it correctly", async () => {
    // The outer UsageTrackingProvider resolves `inferenceProfile` from the
    // ORIGINAL request options, which still carry the failed primary's
    // resolution. The stamp is what lets the usage event bill the fallback
    // serve under the backup profile.
    const primary = failingProvider(
      "openai",
      () => new ProviderError("model not found", "openai", 404),
    );
    const backup = backupProvider();
    const route = makeRoute(backup.provider);
    const wrapped = new RetryProvider(primary.provider, {
      resolveFallbackRoute: route.resolveFallbackRoute,
    });

    const result = await wrapped.sendMessage(MESSAGES, {
      config: { callSite: "mainAgent" },
    });

    expect(result.actualInferenceProfile).toBe("backup-profile");
  });

  test("fallback response with a wrapper-set actualInferenceProfile → preserved, not overwritten", async () => {
    const primary = failingProvider(
      "openai",
      () => new ProviderError("model not found", "openai", 404),
    );
    const backup: Provider = {
      name: "anthropic",
      sendMessage: async () => ({
        ...okResponse("backup-model"),
        actualInferenceProfile: "inner-specific-profile",
      }),
    };
    const route = makeRoute(backup);
    const wrapped = new RetryProvider(primary.provider, {
      resolveFallbackRoute: route.resolveFallbackRoute,
    });

    const result = await wrapped.sendMessage(MESSAGES, {
      config: { callSite: "mainAgent" },
    });

    expect(result.actualInferenceProfile).toBe("inner-specific-profile");
  });

  test("native web search sentinel is dropped when the backup cannot serve it", async () => {
    // The caller appended the sentinel from the PRIMARY route's capability, so
    // a backup without server-side search would answer with a tool call
    // nothing can execute. Degraded mode loses native search, not the turn.
    const primary = failingProvider(
      "openai",
      () => new ProviderError("model not found", "openai", 404),
    );
    const backup = backupProvider("gemini", { supportsNativeWebSearch: false });
    const route = makeRoute(backup.provider);
    const wrapped = new RetryProvider(primary.provider, {
      resolveFallbackRoute: route.resolveFallbackRoute,
    });

    await wrapped.sendMessage(MESSAGES, {
      config: { callSite: "mainAgent", nativeWebSearchSentinel: true },
      tools: [
        {
          name: "read_file",
          description: "d",
          input_schema: { type: "object" },
        },
        {
          name: "web_search",
          description: "d",
          input_schema: { type: "object" },
        },
      ],
    });

    expect(backup.calls()).toBe(1);
    expect(backup.seenToolNames()).toEqual(["read_file"]);
  });

  test("native web search sentinel survives when the backup serves it too", async () => {
    const primary = failingProvider(
      "openai",
      () => new ProviderError("model not found", "openai", 404),
    );
    const backup = backupProvider("anthropic", {
      supportsNativeWebSearch: true,
    });
    const route = makeRoute(backup.provider);
    const wrapped = new RetryProvider(primary.provider, {
      resolveFallbackRoute: route.resolveFallbackRoute,
    });

    await wrapped.sendMessage(MESSAGES, {
      config: { callSite: "mainAgent", nativeWebSearchSentinel: true },
      tools: [
        {
          name: "read_file",
          description: "d",
          input_schema: { type: "object" },
        },
        {
          name: "web_search",
          description: "d",
          input_schema: { type: "object" },
        },
      ],
    });

    expect(backup.seenToolNames()).toEqual(["read_file", "web_search"]);
  });

  test("an app-executed web_search tool survives the fallback untouched", async () => {
    // With a search backend such as Brave or the platform search proxy, the
    // daemon executes `web_search` itself and the caller sets no sentinel
    // marker. Filtering it by name would strip a capability the backup can
    // still serve, so the tool list has to carry over unchanged.
    const primary = failingProvider(
      "openai",
      () => new ProviderError("model not found", "openai", 404),
    );
    const backup = backupProvider("gemini", { supportsNativeWebSearch: false });
    const route = makeRoute(backup.provider);
    const wrapped = new RetryProvider(primary.provider, {
      resolveFallbackRoute: route.resolveFallbackRoute,
    });

    await wrapped.sendMessage(MESSAGES, {
      config: { callSite: "mainAgent" },
      tools: [
        {
          name: "read_file",
          description: "d",
          input_schema: { type: "object" },
        },
        {
          name: "web_search",
          description: "d",
          input_schema: { type: "object" },
        },
      ],
    });

    expect(backup.seenToolNames()).toEqual(["read_file", "web_search"]);
  });

  test("a tool-less call site loses the tool_choice paired with the sentinel", async () => {
    // `AgentLoop` sets `tool_choice: { type: "auto" }` under the same condition
    // that appends the sentinel, so a call site with no tools of its own sends
    // the sentinel as its ONLY tool. Filtering it and leaving the tool_choice
    // behind puts a choice with nothing to choose from on the wire, which
    // Anthropic rejects outright: a recoverable outage would become a hard 400
    // on the backup.
    const primary = failingProvider(
      "openai",
      () => new ProviderError("model not found", "openai", 404),
    );
    const backup = backupProvider("gemini", { supportsNativeWebSearch: false });
    const route = makeRoute(backup.provider);
    const wrapped = new RetryProvider(primary.provider, {
      resolveFallbackRoute: route.resolveFallbackRoute,
    });

    await wrapped.sendMessage(MESSAGES, {
      config: {
        callSite: "mainAgent",
        nativeWebSearchSentinel: true,
        tool_choice: { type: "auto" },
      },
      tools: [
        {
          name: "web_search",
          description: "d",
          input_schema: { type: "object" },
        },
      ],
    });

    expect(backup.calls()).toBe(1);
    expect(backup.seenToolNames()).toEqual([]);
    expect(backup.seenConfig().tool_choice).toBeUndefined();
  });

  test("a tool_choice survives the fallback whenever a tool is left to choose", async () => {
    // The rule is deliberately narrow. A conversation-level `toolChoice` takes
    // precedence over the sentinel's `auto` in `AgentLoop`, so it is caller
    // intent a route change must not quietly discard, and the request it
    // produces is valid on every wire.
    const primary = failingProvider(
      "openai",
      () => new ProviderError("model not found", "openai", 404),
    );
    const backup = backupProvider("gemini", { supportsNativeWebSearch: false });
    const route = makeRoute(backup.provider);
    const wrapped = new RetryProvider(primary.provider, {
      resolveFallbackRoute: route.resolveFallbackRoute,
    });

    await wrapped.sendMessage(MESSAGES, {
      config: {
        callSite: "mainAgent",
        nativeWebSearchSentinel: true,
        tool_choice: { type: "tool", name: "read_file" },
      },
      tools: [
        {
          name: "read_file",
          description: "d",
          input_schema: { type: "object" },
        },
        {
          name: "web_search",
          description: "d",
          input_schema: { type: "object" },
        },
      ],
    });

    expect(backup.seenToolNames()).toEqual(["read_file"]);
    expect(backup.seenConfig().tool_choice).toEqual({
      type: "tool",
      name: "read_file",
    });
  });

  test("a tool_choice survives when the sentinel was never filtered", async () => {
    // A backup that serves native search keeps the whole list, so nothing about
    // the caller's config changes either.
    const primary = failingProvider(
      "openai",
      () => new ProviderError("model not found", "openai", 404),
    );
    const backup = backupProvider("anthropic", {
      supportsNativeWebSearch: true,
    });
    const route = makeRoute(backup.provider);
    const wrapped = new RetryProvider(primary.provider, {
      resolveFallbackRoute: route.resolveFallbackRoute,
    });

    await wrapped.sendMessage(MESSAGES, {
      config: {
        callSite: "mainAgent",
        nativeWebSearchSentinel: true,
        tool_choice: { type: "auto" },
      },
      tools: [
        {
          name: "web_search",
          description: "d",
          input_schema: { type: "object" },
        },
      ],
    });

    expect(backup.seenToolNames()).toEqual(["web_search"]);
    expect(backup.seenConfig().tool_choice).toEqual({ type: "auto" });
  });

  test("the sentinel marker never reaches the provider wire config", async () => {
    const primary = failingProvider(
      "openai",
      () => new ProviderError("model not found", "openai", 404),
    );
    const backup = backupProvider("gemini", { supportsNativeWebSearch: false });
    const route = makeRoute(backup.provider);
    const wrapped = new RetryProvider(primary.provider, {
      resolveFallbackRoute: route.resolveFallbackRoute,
    });

    await wrapped.sendMessage(MESSAGES, {
      config: { callSite: "mainAgent", nativeWebSearchSentinel: true },
      tools: [
        {
          name: "web_search",
          description: "d",
          input_schema: { type: "object" },
        },
      ],
    });

    expect(backup.seenConfig().nativeWebSearchSentinel).toBeUndefined();
  });
});
