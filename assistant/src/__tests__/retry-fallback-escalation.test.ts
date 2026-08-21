import { beforeEach, describe, expect, mock, test } from "bun:test";

import * as retryUtil from "../util/retry.js";

// Instant sleep so exhausted-retry cases don't wait out real backoff delays;
// everything else is the real module.
mock.module("../util/retry.js", () => ({
  ...retryUtil,
  sleep: async () => {},
}));

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
function backupProvider(name = "anthropic"): {
  provider: Provider;
  calls: () => number;
  seenConfig: () => Record<string, unknown>;
} {
  let calls = 0;
  let seen: SendMessageOptions | undefined;
  const provider: Provider = {
    name,
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
  };
}

function makeRoute(
  provider: Provider,
  overrideProfile = "backup-profile",
): {
  resolveFallbackRoute: (
    failedOptions: SendMessageOptions | undefined,
  ) => Promise<{ provider: Provider; overrideProfile: string } | null>;
  calls: () => number;
} {
  let calls = 0;
  return {
    resolveFallbackRoute: async () => {
      calls += 1;
      return { provider, overrideProfile };
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

describe("RetryProvider — fallback-route escalation", () => {
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

  test("explicit config.model pin + outage-shaped error → callback never invoked, original error rethrown", async () => {
    // Per-conversation `modelOverride` is a live feature; a pinned
    // conversation keeps today's retry-then-error behavior — the fallback
    // must never silently serve a different model against an explicit pin.
    const finalError = new ProviderError("Service Unavailable", "openai", 503);
    const primary = failingProvider("openai", () => finalError);
    const route = makeRoute(backupProvider().provider);
    const wrapped = new RetryProvider(primary.provider, {
      resolveFallbackRoute: route.resolveFallbackRoute,
    });

    const thrown = await captureError(
      wrapped.sendMessage(MESSAGES, {
        config: { callSite: "mainAgent", model: "pinned-model" },
      }),
    );

    expect(thrown).toBe(finalError);
    expect(route.calls()).toBe(0);
    expect((thrown as { retriesExhausted?: boolean }).retriesExhausted).toBe(
      true,
    );
  });

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

  test("backup also fails → fallback error rethrown with original as cause, no second fallback attempt", async () => {
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

    expect(thrown).toBe(fallbackError);
    expect((thrown as Error).cause).toBe(originalError);
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
});
