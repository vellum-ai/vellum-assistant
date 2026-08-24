/**
 * The fallback circuit breaker: its own state machine under an injected clock,
 * and the `RetryProvider` behavior it drives.
 *
 * Deliberately mock-free. The breaker takes `now` on every entry point, so the
 * state machine is tested against explicit timestamps instead of a faked
 * global clock, and the `RetryProvider` cases use stub providers whose call
 * counts are the assertion.
 */

import { beforeEach, describe, expect, test } from "bun:test";

import {
  recordFallbackServed,
  recordPrimaryFailure,
  recordPrimarySuccess,
  releaseRecoveryProbe,
  resetFallbackBreaker,
  shouldSkipPrimary,
  tryAcquireRecoveryProbe,
} from "../providers/fallback-breaker.js";
import { RetryProvider } from "../providers/retry.js";
import type {
  Message,
  Provider,
  ProviderResponse,
  SendMessageOptions,
} from "../providers/types.js";
import { ProviderError } from "../util/errors.js";
import { setConfig } from "./helpers/set-config.js";

// ── Fixtures ────────────────────────────────────────────────────────────────

const UPSTREAM = "openai";
const T0 = 1_700_000_000_000;

const FAILURE_WINDOW_MS = 5 * 60_000;
const BASE_COOLDOWN_MS = 120_000;
const MAX_COOLDOWN_MS = 10 * 60_000;
const JITTER = 0.2;

const MESSAGES: Message[] = [
  { role: "user", content: [{ type: "text", text: "hi" }] },
];

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
  resetFallbackBreaker();
  setConfig("llm", LLM_FIXTURE);
});

/**
 * The cooldown the breaker actually picked, recovered by bisecting the first
 * offset from `trippedAt` at which it stops skipping the primary. Jitter makes
 * the value unpredictable by design, so tests assert on the band it lands in
 * rather than on a number the test itself computed.
 */
function observedCooldownMs(trippedAt: number): number {
  let lo = 0;
  let hi = MAX_COOLDOWN_MS + 1;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (shouldSkipPrimary(UPSTREAM, trippedAt + mid)) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

function expectWithinJitterBand(cooldown: number, base: number): void {
  expect(cooldown).toBeGreaterThanOrEqual(Math.floor(base * (1 - JITTER)));
  expect(cooldown).toBeLessThanOrEqual(Math.ceil(base * (1 + JITTER)));
  expect(cooldown).toBeLessThanOrEqual(MAX_COOLDOWN_MS);
}

function okResponse(model: string): ProviderResponse {
  return {
    content: [{ type: "text", text: "ok" }],
    model,
    usage: { inputTokens: 1, outputTokens: 1 },
    stopReason: "end_turn",
  } as ProviderResponse;
}

/** Primary stub that answers, or throws `makeError()` when one is given. */
function primaryProvider(makeError?: () => unknown): {
  provider: Provider;
  calls: () => number;
} {
  let calls = 0;
  const provider: Provider = {
    name: UPSTREAM,
    sendMessage: async () => {
      calls += 1;
      if (makeError) {
        throw makeError();
      }
      return okResponse("primary-model");
    },
  };
  return { provider, calls: () => calls };
}

/** Backup stub that serves whatever model the re-normalized options resolved. */
function backupProvider(): { provider: Provider; calls: () => number } {
  let calls = 0;
  const provider: Provider = {
    name: "anthropic",
    sendMessage: async (_messages: Message[], options?: SendMessageOptions) => {
      calls += 1;
      const config = options?.config as Record<string, unknown> | undefined;
      return okResponse((config?.model as string | undefined) ?? "unresolved");
    },
  };
  return { provider, calls: () => calls };
}

function makeRoute(provider: Provider): {
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
      return {
        provider,
        overrideProfile: "backup-profile",
        forwardUsageAttributionHeaders: true,
      };
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

// ── The breaker state machine ───────────────────────────────────────────────

describe("fallback breaker state machine", () => {
  test("two eligible failures inside the window trip the breaker", () => {
    recordPrimaryFailure(UPSTREAM, T0);
    expect(shouldSkipPrimary(UPSTREAM, T0)).toBe(false);

    recordPrimaryFailure(UPSTREAM, T0 + 1_000);
    expect(shouldSkipPrimary(UPSTREAM, T0 + 1_000)).toBe(true);
  });

  test("failures spread beyond the window never accumulate into a trip", () => {
    recordPrimaryFailure(UPSTREAM, T0);
    recordPrimaryFailure(UPSTREAM, T0 + FAILURE_WINDOW_MS + 1);
    expect(shouldSkipPrimary(UPSTREAM, T0 + FAILURE_WINDOW_MS + 1)).toBe(false);
  });

  test("a success between failures resets the count, so isolated blips never trip", () => {
    recordPrimaryFailure(UPSTREAM, T0);
    recordPrimarySuccess(UPSTREAM, T0 + 1_000);
    recordPrimaryFailure(UPSTREAM, T0 + 2_000);
    expect(shouldSkipPrimary(UPSTREAM, T0 + 2_000)).toBe(false);

    recordPrimaryFailure(UPSTREAM, T0 + 3_000);
    expect(shouldSkipPrimary(UPSTREAM, T0 + 3_000)).toBe(true);
  });

  test("a completed backup serve trips the breaker on its own", () => {
    recordFallbackServed(UPSTREAM, T0);
    expect(shouldSkipPrimary(UPSTREAM, T0)).toBe(true);
  });

  test("a success closes an open breaker", () => {
    recordFallbackServed(UPSTREAM, T0);
    recordPrimarySuccess(UPSTREAM, T0 + 1_000);
    expect(shouldSkipPrimary(UPSTREAM, T0 + 1_000)).toBe(false);
  });

  test("the cooldown lands inside the jitter band and varies between trips", () => {
    const seen = new Set<number>();
    for (let i = 0; i < 40; i += 1) {
      resetFallbackBreaker();
      recordFallbackServed(UPSTREAM, T0);
      const cooldown = observedCooldownMs(T0);
      expectWithinJitterBand(cooldown, BASE_COOLDOWN_MS);
      seen.add(cooldown);
    }
    // Jitter exists so a fleet of daemons does not probe a recovering upstream
    // in the same second; a constant cooldown would defeat that.
    expect(seen.size).toBeGreaterThan(1);
  });

  test("after the cooldown exactly one caller wins the probe, the rest keep skipping", () => {
    recordFallbackServed(UPSTREAM, T0);
    const cooldown = observedCooldownMs(T0);
    const ready = T0 + cooldown;

    expect(shouldSkipPrimary(UPSTREAM, ready)).toBe(false);
    expect(tryAcquireRecoveryProbe(UPSTREAM, ready)).toBe(true);

    // While that probe is deciding recovery, everyone else stays on the backup
    // rather than piling onto a route that may still be down.
    expect(tryAcquireRecoveryProbe(UPSTREAM, ready)).toBe(false);
    expect(shouldSkipPrimary(UPSTREAM, ready)).toBe(true);
    expect(shouldSkipPrimary(UPSTREAM, ready + 60_000)).toBe(true);
  });

  test("a successful probe closes the breaker", () => {
    recordFallbackServed(UPSTREAM, T0);
    const ready = T0 + observedCooldownMs(T0);
    expect(tryAcquireRecoveryProbe(UPSTREAM, ready)).toBe(true);

    releaseRecoveryProbe(UPSTREAM, true, ready + 500);

    expect(shouldSkipPrimary(UPSTREAM, ready + 500)).toBe(false);
    expect(tryAcquireRecoveryProbe(UPSTREAM, ready + 500)).toBe(false);
  });

  test("a failed probe re-trips with a doubled cooldown, capped at 10 minutes", () => {
    recordFallbackServed(UPSTREAM, T0);
    let at = T0;
    expectWithinJitterBand(observedCooldownMs(at), BASE_COOLDOWN_MS);

    for (const expectedBase of [
      BASE_COOLDOWN_MS * 2,
      BASE_COOLDOWN_MS * 4,
      MAX_COOLDOWN_MS,
      MAX_COOLDOWN_MS,
    ]) {
      at += observedCooldownMs(at);
      expect(tryAcquireRecoveryProbe(UPSTREAM, at)).toBe(true);
      releaseRecoveryProbe(UPSTREAM, false, at);
      expectWithinJitterBand(observedCooldownMs(at), expectedBase);
    }
  });

  test("resetFallbackBreaker drops every remembered route", () => {
    recordFallbackServed(UPSTREAM, T0);
    resetFallbackBreaker();
    expect(shouldSkipPrimary(UPSTREAM, T0)).toBe(false);
  });
});

// ── What RetryProvider does with it ─────────────────────────────────────────

describe("RetryProvider under an open breaker", () => {
  test("a tripped route goes straight to the backup without calling the primary", async () => {
    const primary = primaryProvider(
      () => new ProviderError("Service Unavailable", UPSTREAM, 503),
    );
    const backup = backupProvider();
    const route = makeRoute(backup.provider);
    const wrapped = new RetryProvider(primary.provider, {
      resolveFallbackRoute: route.resolveFallbackRoute,
    });
    recordFallbackServed(UPSTREAM);

    const startedAt = Date.now();
    const result = await wrapped.sendMessage(MESSAGES, {
      config: { callSite: "mainAgent" },
    });

    expect(result.model).toBe("backup-model");
    expect(primary.calls()).toBe(0);
    expect(backup.calls()).toBe(1);
    // Skipping the primary also skips its retry budget, so no backoff delay is
    // spent on a route already known to be down.
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  test("an elapsed cooldown admits one probe, and its success restores the primary", async () => {
    const primary = primaryProvider();
    const backup = backupProvider();
    const route = makeRoute(backup.provider);
    const wrapped = new RetryProvider(primary.provider, {
      resolveFallbackRoute: route.resolveFallbackRoute,
    });
    // Tripped long enough ago that the longest possible cooldown has expired.
    recordFallbackServed(UPSTREAM, Date.now() - MAX_COOLDOWN_MS - 1);

    const result = await wrapped.sendMessage(MESSAGES, {
      config: { callSite: "mainAgent" },
    });

    expect(result.model).toBe("primary-model");
    expect(primary.calls()).toBe(1);
    expect(backup.calls()).toBe(0);
    // The breaker is closed, so the next request takes the primary directly.
    expect(shouldSkipPrimary(UPSTREAM)).toBe(false);

    const second = await wrapped.sendMessage(MESSAGES, {
      config: { callSite: "mainAgent" },
    });
    expect(second.model).toBe("primary-model");
    expect(primary.calls()).toBe(2);
  });

  test("a failed probe re-trips the breaker and the backup serves that request", async () => {
    const primary = primaryProvider(
      () => new ProviderError("Service Unavailable", UPSTREAM, 503),
    );
    const backup = backupProvider();
    const route = makeRoute(backup.provider);
    const wrapped = new RetryProvider(primary.provider, {
      resolveFallbackRoute: route.resolveFallbackRoute,
    });
    recordFallbackServed(UPSTREAM, Date.now() - MAX_COOLDOWN_MS - 1);

    const result = await wrapped.sendMessage(MESSAGES, {
      config: { callSite: "mainAgent" },
    });

    // One probe attempt, no retry loop behind it, then the backup.
    expect(primary.calls()).toBe(1);
    expect(result.model).toBe("backup-model");
    expect(shouldSkipPrimary(UPSTREAM)).toBe(true);
  });

  test("a probe rejected by the primary itself closes the breaker and surfaces the error", async () => {
    // A plain 400 is the route answering the request, which is all the probe
    // asked: the upstream is up, so the breaker closes and the caller sees the
    // real error instead of a backup answer to a malformed request.
    const requestError = new ProviderError("invalid request", UPSTREAM, 400);
    const primary = primaryProvider(() => requestError);
    const backup = backupProvider();
    const route = makeRoute(backup.provider);
    const wrapped = new RetryProvider(primary.provider, {
      resolveFallbackRoute: route.resolveFallbackRoute,
    });
    recordFallbackServed(UPSTREAM, Date.now() - MAX_COOLDOWN_MS - 1);

    const thrown = await captureError(
      wrapped.sendMessage(MESSAGES, { config: { callSite: "mainAgent" } }),
    );

    expect(thrown).toBe(requestError);
    expect(primary.calls()).toBe(1);
    expect(backup.calls()).toBe(0);
    expect(shouldSkipPrimary(UPSTREAM)).toBe(false);
  });

  test("a route without resolveFallbackRoute never consults the breaker", async () => {
    // BYOK and every other route with no escalation hook keep today's
    // behavior: a remembered outage on the same upstream name is irrelevant to
    // them, and their traffic must not close it either.
    const primary = primaryProvider();
    const wrapped = new RetryProvider(primary.provider);
    recordFallbackServed(UPSTREAM);

    const result = await wrapped.sendMessage(MESSAGES, {
      config: { callSite: "mainAgent" },
    });

    expect(result.model).toBe("primary-model");
    expect(primary.calls()).toBe(1);
    expect(shouldSkipPrimary(UPSTREAM)).toBe(true);
  });

  test("a request pinned to an explicit model ignores an open breaker", async () => {
    // A pinned request can never re-route (the pin outranks any backup
    // profile), so skipping the primary would only lose it the only route it
    // has.
    const pinError = new ProviderError("invalid request", UPSTREAM, 400);
    const primary = primaryProvider(() => pinError);
    const backup = backupProvider();
    const route = makeRoute(backup.provider);
    const wrapped = new RetryProvider(primary.provider, {
      resolveFallbackRoute: route.resolveFallbackRoute,
    });
    recordFallbackServed(UPSTREAM);

    const thrown = await captureError(
      wrapped.sendMessage(MESSAGES, {
        config: { callSite: "mainAgent", model: "pinned-model" },
      }),
    );

    expect(thrown).toBe(pinError);
    expect(primary.calls()).toBe(1);
    expect(backup.calls()).toBe(0);
  });

  test("a fallback serve trips the breaker for the next request", async () => {
    const primary = primaryProvider(
      () => new ProviderError("model not found", UPSTREAM, 404),
    );
    const backup = backupProvider();
    const route = makeRoute(backup.provider);
    const wrapped = new RetryProvider(primary.provider, {
      resolveFallbackRoute: route.resolveFallbackRoute,
    });

    await wrapped.sendMessage(MESSAGES, { config: { callSite: "mainAgent" } });
    expect(primary.calls()).toBe(1);

    await wrapped.sendMessage(MESSAGES, { config: { callSite: "mainAgent" } });
    expect(primary.calls()).toBe(1);
    expect(backup.calls()).toBe(2);
  });
});
