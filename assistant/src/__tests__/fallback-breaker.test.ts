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
  type BreakerRoute,
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

/** The whole upstream, as an outage marks it. */
const UPSTREAM_ROUTE: BreakerRoute = { upstream: UPSTREAM };
/** The primary profile's own model, as a retirement marks it. */
const PRIMARY_ROUTE: BreakerRoute = {
  upstream: UPSTREAM,
  model: "primary-model",
};
/** A second, healthy model on the same upstream. */
const OTHER_ROUTE: BreakerRoute = { upstream: UPSTREAM, model: "other-model" };

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
    // A second profile on the same upstream, so a model-scoped trip can be
    // shown to leave healthy models alone.
    "other-profile": {
      source: "user",
      provider: "openai",
      model: "other-model",
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

/** Per-call config that resolves to `other-model` on the same upstream. */
const OTHER_MODEL_CALL = {
  callSite: "mainAgent",
  overrideProfile: "other-profile",
  forceOverrideProfile: true,
} as const;

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
function observedCooldownMs(route: BreakerRoute, trippedAt: number): number {
  let lo = 0;
  let hi = MAX_COOLDOWN_MS + 1;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (shouldSkipPrimary(route, trippedAt + mid)) {
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

/**
 * Primary stub that answers with whatever model the resolved options carry, or
 * throws the next error from `errors` while any remain.
 */
function primaryProvider(...errors: (() => unknown)[]): {
  provider: Provider;
  calls: () => number;
  seenModels: () => (string | undefined)[];
} {
  const seen: (string | undefined)[] = [];
  let calls = 0;
  const provider: Provider = {
    name: UPSTREAM,
    sendMessage: async (_messages: Message[], options?: SendMessageOptions) => {
      calls += 1;
      seen.push(options?.config?.model);
      const next = errors.shift();
      if (next) {
        throw next();
      }
      return okResponse(options?.config?.model ?? "unresolved");
    },
  };
  return { provider, calls: () => calls, seenModels: () => seen };
}

/** Backup stub that serves whatever model the re-normalized options resolved. */
function backupProvider(): { provider: Provider; calls: () => number } {
  let calls = 0;
  const provider: Provider = {
    name: "anthropic",
    sendMessage: async (_messages: Message[], options?: SendMessageOptions) => {
      calls += 1;
      return okResponse(options?.config?.model ?? "unresolved");
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
    recordPrimaryFailure(UPSTREAM_ROUTE, T0);
    expect(shouldSkipPrimary(UPSTREAM_ROUTE, T0)).toBe(false);

    recordPrimaryFailure(UPSTREAM_ROUTE, T0 + 1_000);
    expect(shouldSkipPrimary(UPSTREAM_ROUTE, T0 + 1_000)).toBe(true);
  });

  test("failures spread beyond the window never accumulate into a trip", () => {
    recordPrimaryFailure(UPSTREAM_ROUTE, T0);
    recordPrimaryFailure(UPSTREAM_ROUTE, T0 + FAILURE_WINDOW_MS + 1);
    expect(shouldSkipPrimary(UPSTREAM_ROUTE, T0 + FAILURE_WINDOW_MS + 1)).toBe(
      false,
    );
  });

  test("a success between failures resets the count, so isolated blips never trip", () => {
    recordPrimaryFailure(UPSTREAM_ROUTE, T0);
    recordPrimarySuccess(UPSTREAM_ROUTE, T0 + 1_000);
    recordPrimaryFailure(UPSTREAM_ROUTE, T0 + 2_000);
    expect(shouldSkipPrimary(UPSTREAM_ROUTE, T0 + 2_000)).toBe(false);

    recordPrimaryFailure(UPSTREAM_ROUTE, T0 + 3_000);
    expect(shouldSkipPrimary(UPSTREAM_ROUTE, T0 + 3_000)).toBe(true);
  });

  test("a completed backup serve trips the breaker on its own", () => {
    recordFallbackServed(UPSTREAM_ROUTE, T0);
    expect(shouldSkipPrimary(UPSTREAM_ROUTE, T0)).toBe(true);
  });

  test("a success closes an open breaker", () => {
    recordFallbackServed(UPSTREAM_ROUTE, T0);
    recordPrimarySuccess(UPSTREAM_ROUTE, T0 + 1_000);
    expect(shouldSkipPrimary(UPSTREAM_ROUTE, T0 + 1_000)).toBe(false);
  });

  test("the cooldown lands inside the jitter band and varies between trips", () => {
    const seen = new Set<number>();
    for (let i = 0; i < 40; i += 1) {
      resetFallbackBreaker();
      recordFallbackServed(UPSTREAM_ROUTE, T0);
      const cooldown = observedCooldownMs(UPSTREAM_ROUTE, T0);
      expectWithinJitterBand(cooldown, BASE_COOLDOWN_MS);
      seen.add(cooldown);
    }
    // Jitter exists so a fleet of daemons does not probe a recovering upstream
    // in the same second; a constant cooldown would defeat that.
    expect(seen.size).toBeGreaterThan(1);
  });

  test("after the cooldown exactly one caller wins the probe, the rest keep skipping", () => {
    recordFallbackServed(UPSTREAM_ROUTE, T0);
    const cooldown = observedCooldownMs(UPSTREAM_ROUTE, T0);
    const ready = T0 + cooldown;

    expect(shouldSkipPrimary(UPSTREAM_ROUTE, ready)).toBe(false);
    expect(tryAcquireRecoveryProbe(UPSTREAM_ROUTE, ready)).toBe(true);

    // While that probe is deciding recovery, everyone else stays on the backup
    // rather than piling onto a route that may still be down.
    expect(tryAcquireRecoveryProbe(UPSTREAM_ROUTE, ready)).toBe(false);
    expect(shouldSkipPrimary(UPSTREAM_ROUTE, ready)).toBe(true);
    expect(shouldSkipPrimary(UPSTREAM_ROUTE, ready + 60_000)).toBe(true);
  });

  test("a successful probe closes the breaker", () => {
    recordFallbackServed(UPSTREAM_ROUTE, T0);
    const ready = T0 + observedCooldownMs(UPSTREAM_ROUTE, T0);
    expect(tryAcquireRecoveryProbe(UPSTREAM_ROUTE, ready)).toBe(true);

    releaseRecoveryProbe(UPSTREAM_ROUTE, { verdict: "recovered" }, ready + 500);

    expect(shouldSkipPrimary(UPSTREAM_ROUTE, ready + 500)).toBe(false);
    expect(tryAcquireRecoveryProbe(UPSTREAM_ROUTE, ready + 500)).toBe(false);
  });

  test("a failed probe re-trips with a doubled cooldown, capped at 10 minutes", () => {
    recordFallbackServed(UPSTREAM_ROUTE, T0);
    let at = T0;
    expectWithinJitterBand(
      observedCooldownMs(UPSTREAM_ROUTE, at),
      BASE_COOLDOWN_MS,
    );

    for (const expectedBase of [
      BASE_COOLDOWN_MS * 2,
      BASE_COOLDOWN_MS * 4,
      MAX_COOLDOWN_MS,
      MAX_COOLDOWN_MS,
    ]) {
      at += observedCooldownMs(UPSTREAM_ROUTE, at);
      expect(tryAcquireRecoveryProbe(UPSTREAM_ROUTE, at)).toBe(true);
      releaseRecoveryProbe(
        UPSTREAM_ROUTE,
        { verdict: "failing", failedRoute: UPSTREAM_ROUTE },
        at,
      );
      expectWithinJitterBand(
        observedCooldownMs(UPSTREAM_ROUTE, at),
        expectedBase,
      );
    }
  });

  test("resetFallbackBreaker drops every remembered route", () => {
    recordFallbackServed(UPSTREAM_ROUTE, T0);
    resetFallbackBreaker();
    expect(shouldSkipPrimary(UPSTREAM_ROUTE, T0)).toBe(false);
  });
});

// ── Scope: one model versus the whole upstream ──────────────────────────────

describe("fallback breaker scope", () => {
  test("a retired model is remembered for that model alone", () => {
    recordFallbackServed(PRIMARY_ROUTE, T0);

    expect(shouldSkipPrimary(PRIMARY_ROUTE, T0)).toBe(true);
    // A healthy profile on the same upstream keeps its own primary: the
    // upstream never failed, one model on it did.
    expect(shouldSkipPrimary(OTHER_ROUTE, T0)).toBe(false);
    expect(shouldSkipPrimary(UPSTREAM_ROUTE, T0)).toBe(false);
  });

  test("an upstream outage is remembered for every model on it", () => {
    recordFallbackServed(UPSTREAM_ROUTE, T0);

    expect(shouldSkipPrimary(PRIMARY_ROUTE, T0)).toBe(true);
    expect(shouldSkipPrimary(OTHER_ROUTE, T0)).toBe(true);
  });

  test("probing a healthy model does not close another model's outage", () => {
    recordFallbackServed(PRIMARY_ROUTE, T0);
    // Remembered long enough ago that its cooldown has expired and a probe is
    // due, unlike the retired model's.
    recordFallbackServed(OTHER_ROUTE, T0 - MAX_COOLDOWN_MS - 1);

    expect(tryAcquireRecoveryProbe(OTHER_ROUTE, T0)).toBe(true);
    releaseRecoveryProbe(OTHER_ROUTE, { verdict: "recovered" }, T0);

    expect(shouldSkipPrimary(OTHER_ROUTE, T0)).toBe(false);
    expect(shouldSkipPrimary(PRIMARY_ROUTE, T0)).toBe(true);
  });

  test("a success on one model leaves another model's outage remembered", () => {
    recordFallbackServed(PRIMARY_ROUTE, T0);
    recordPrimarySuccess(OTHER_ROUTE, T0 + 1_000);
    expect(shouldSkipPrimary(PRIMARY_ROUTE, T0 + 1_000)).toBe(true);
  });

  test("a success on any model closes an upstream-wide outage", () => {
    // The upstream answered, which is what an upstream-wide trip was claiming
    // it would not do.
    recordFallbackServed(UPSTREAM_ROUTE, T0);
    recordPrimarySuccess(OTHER_ROUTE, T0 + 1_000);
    expect(shouldSkipPrimary(PRIMARY_ROUTE, T0 + 1_000)).toBe(false);
  });

  test("a probe needs every outage covering the route to have cooled down", () => {
    recordFallbackServed(UPSTREAM_ROUTE, T0);
    // The model's own outage is remembered later, so its cooldown outlasts the
    // upstream's.
    recordFallbackServed(PRIMARY_ROUTE, T0 + MAX_COOLDOWN_MS);
    const upstreamReady = T0 + observedCooldownMs(UPSTREAM_ROUTE, T0);

    expect(tryAcquireRecoveryProbe(PRIMARY_ROUTE, upstreamReady)).toBe(false);
    expect(shouldSkipPrimary(PRIMARY_ROUTE, upstreamReady)).toBe(true);
  });

  test("a probe failing on one model narrows an upstream outage to that model", () => {
    // The upstream answered the probe, so it is no longer the thing that is
    // down; what it answered with is about a single model.
    recordFallbackServed(UPSTREAM_ROUTE, T0);
    const ready = T0 + observedCooldownMs(UPSTREAM_ROUTE, T0);
    expect(tryAcquireRecoveryProbe(PRIMARY_ROUTE, ready)).toBe(true);

    releaseRecoveryProbe(
      PRIMARY_ROUTE,
      { verdict: "failing", failedRoute: PRIMARY_ROUTE },
      ready,
    );

    // Every healthy model on the upstream is servable again.
    expect(shouldSkipPrimary(OTHER_ROUTE, ready)).toBe(false);
    expect(shouldSkipPrimary(UPSTREAM_ROUTE, ready)).toBe(false);
    // The model the probe indicted is still skipped, on the escalated cooldown
    // the failed probe earned rather than a fresh base wait.
    expect(shouldSkipPrimary(PRIMARY_ROUTE, ready)).toBe(true);
    expectWithinJitterBand(
      observedCooldownMs(PRIMARY_ROUTE, ready),
      BASE_COOLDOWN_MS * 2,
    );

    // And it is still clearable: nothing is stranded by the narrowing.
    const modelReady = ready + observedCooldownMs(PRIMARY_ROUTE, ready);
    expect(tryAcquireRecoveryProbe(PRIMARY_ROUTE, modelReady)).toBe(true);
    releaseRecoveryProbe(PRIMARY_ROUTE, { verdict: "recovered" }, modelReady);
    expect(shouldSkipPrimary(PRIMARY_ROUTE, modelReady)).toBe(false);
  });

  test("a probe failing with an outage widens a model's outage to the upstream", () => {
    recordFallbackServed(PRIMARY_ROUTE, T0);
    const ready = T0 + observedCooldownMs(PRIMARY_ROUTE, T0);
    expect(tryAcquireRecoveryProbe(PRIMARY_ROUTE, ready)).toBe(true);

    releaseRecoveryProbe(
      PRIMARY_ROUTE,
      { verdict: "failing", failedRoute: UPSTREAM_ROUTE },
      ready,
    );

    // The fresh evidence is upstream-wide, so it governs every model on it.
    expect(shouldSkipPrimary(OTHER_ROUTE, ready)).toBe(true);
    expect(shouldSkipPrimary(PRIMARY_ROUTE, ready)).toBe(true);
    expectWithinJitterBand(
      observedCooldownMs(UPSTREAM_ROUTE, ready),
      BASE_COOLDOWN_MS * 2,
    );
  });

  test("a probe failure the breaker cannot name closes what it tested", () => {
    recordFallbackServed(UPSTREAM_ROUTE, T0);
    const ready = T0 + observedCooldownMs(UPSTREAM_ROUTE, T0);
    expect(tryAcquireRecoveryProbe(UPSTREAM_ROUTE, ready)).toBe(true);

    releaseRecoveryProbe(
      UPSTREAM_ROUTE,
      { verdict: "failing", failedRoute: null },
      ready,
    );

    // Better to rediscover the outage on the next request than to keep an
    // entry open that names something no future probe can clear.
    expect(shouldSkipPrimary(PRIMARY_ROUTE, ready)).toBe(false);
  });

  test("an abandoned probe hands the claim back and changes nothing else", () => {
    recordFallbackServed(UPSTREAM_ROUTE, T0);
    const cooldown = observedCooldownMs(UPSTREAM_ROUTE, T0);
    const ready = T0 + cooldown;
    expect(tryAcquireRecoveryProbe(UPSTREAM_ROUTE, ready)).toBe(true);

    releaseRecoveryProbe(UPSTREAM_ROUTE, { verdict: "abandoned" }, ready);

    // The entry survives with the same deadline: a cancelled probe neither
    // recovers the route nor restarts its wait.
    expect(observedCooldownMs(UPSTREAM_ROUTE, T0)).toBe(cooldown);
    // Concurrent traffic during the cancelled probe was skipping the primary;
    // now the claim is free, so the next request can probe instead.
    expect(tryAcquireRecoveryProbe(UPSTREAM_ROUTE, ready)).toBe(true);
    releaseRecoveryProbe(UPSTREAM_ROUTE, { verdict: "recovered" }, ready);
    expect(shouldSkipPrimary(UPSTREAM_ROUTE, ready)).toBe(false);
  });

  test("an abandoned probe does not count toward the escalation", () => {
    recordFallbackServed(UPSTREAM_ROUTE, T0);
    const ready = T0 + observedCooldownMs(UPSTREAM_ROUTE, T0);

    expect(tryAcquireRecoveryProbe(UPSTREAM_ROUTE, ready)).toBe(true);
    releaseRecoveryProbe(UPSTREAM_ROUTE, { verdict: "abandoned" }, ready);
    expect(tryAcquireRecoveryProbe(UPSTREAM_ROUTE, ready)).toBe(true);
    releaseRecoveryProbe(
      UPSTREAM_ROUTE,
      { verdict: "failing", failedRoute: UPSTREAM_ROUTE },
      ready,
    );

    // The first real failure earns the first doubling. Counting the
    // cancellation would have skipped a rung and made the route wait twice as
    // long for no evidence.
    expectWithinJitterBand(
      observedCooldownMs(UPSTREAM_ROUTE, ready),
      BASE_COOLDOWN_MS * 2,
    );
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
    recordFallbackServed(UPSTREAM_ROUTE);

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
    recordFallbackServed(UPSTREAM_ROUTE, Date.now() - MAX_COOLDOWN_MS - 1);

    const result = await wrapped.sendMessage(MESSAGES, {
      config: { callSite: "mainAgent" },
    });

    expect(result.model).toBe("primary-model");
    expect(primary.calls()).toBe(1);
    expect(backup.calls()).toBe(0);
    // The breaker is closed, so the next request takes the primary directly.
    expect(shouldSkipPrimary(PRIMARY_ROUTE)).toBe(false);

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
    recordFallbackServed(UPSTREAM_ROUTE, Date.now() - MAX_COOLDOWN_MS - 1);

    const result = await wrapped.sendMessage(MESSAGES, {
      config: { callSite: "mainAgent" },
    });

    // One probe attempt, no retry loop behind it, then the backup.
    expect(primary.calls()).toBe(1);
    expect(result.model).toBe("backup-model");
    expect(shouldSkipPrimary(PRIMARY_ROUTE)).toBe(true);
  });

  test("a probe refreshes an expired managed credential before judging the route down", async () => {
    // The credential expired during the outage. Without the refresh the probe
    // reads its own 401 as the outage continuing, re-trips, and the route can
    // never come back.
    const primary = primaryProvider(
      () =>
        new ProviderError("Unauthorized", UPSTREAM, 401, {
          reason: "invalid_credentials",
        }),
    );
    const refreshed = primaryProvider();
    const backup = backupProvider();
    const route = makeRoute(backup.provider);
    let refreshCalls = 0;
    const wrapped = new RetryProvider(primary.provider, {
      credentialSource: "vellum-managed",
      refreshCredentialProvider: async () => {
        refreshCalls += 1;
        return refreshed.provider;
      },
      resolveFallbackRoute: route.resolveFallbackRoute,
    });
    recordFallbackServed(UPSTREAM_ROUTE, Date.now() - MAX_COOLDOWN_MS - 1);

    const result = await wrapped.sendMessage(MESSAGES, {
      config: { callSite: "mainAgent" },
    });

    expect(refreshCalls).toBe(1);
    expect(primary.calls()).toBe(1);
    // Still one probe: the refreshed adapter serves the same single attempt.
    expect(refreshed.calls()).toBe(1);
    expect(backup.calls()).toBe(0);
    expect(result.model).toBe("primary-model");
    expect(shouldSkipPrimary(PRIMARY_ROUTE)).toBe(false);
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
    recordFallbackServed(UPSTREAM_ROUTE, Date.now() - MAX_COOLDOWN_MS - 1);

    const thrown = await captureError(
      wrapped.sendMessage(MESSAGES, { config: { callSite: "mainAgent" } }),
    );

    expect(thrown).toBe(requestError);
    expect(primary.calls()).toBe(1);
    expect(backup.calls()).toBe(0);
    expect(shouldSkipPrimary(PRIMARY_ROUTE)).toBe(false);
  });

  test("a cancelled probe leaves the breaker tripped instead of reporting recovery", async () => {
    const cancelled = new ProviderError(
      "Request was aborted.",
      UPSTREAM,
      undefined,
      { abortReason: "user_cancelled" },
    );
    const primary = primaryProvider(
      () => cancelled,
      () => new ProviderError("Service Unavailable", UPSTREAM, 503),
    );
    const backup = backupProvider();
    const route = makeRoute(backup.provider);
    const wrapped = new RetryProvider(primary.provider, {
      resolveFallbackRoute: route.resolveFallbackRoute,
    });
    recordFallbackServed(UPSTREAM_ROUTE, Date.now() - MAX_COOLDOWN_MS - 1);

    const thrown = await captureError(
      wrapped.sendMessage(MESSAGES, { config: { callSite: "mainAgent" } }),
    );

    // The cancellation surfaces as itself and nothing is re-routed: a request
    // the caller stopped must stay stopped.
    expect(thrown).toBe(cancelled);
    expect(primary.calls()).toBe(1);
    expect(backup.calls()).toBe(0);

    // The entry survived the cancellation, so the next request probes once and
    // escalates. Had the cancellation been read as recovery, this request would
    // have paid the primary's whole retry budget instead.
    const next = await wrapped.sendMessage(MESSAGES, {
      config: { callSite: "mainAgent" },
    });
    expect(next.model).toBe("backup-model");
    expect(primary.calls()).toBe(2);
    expect(backup.calls()).toBe(1);
    expect(shouldSkipPrimary(PRIMARY_ROUTE)).toBe(true);
  });

  test("a route without resolveFallbackRoute never consults the breaker", async () => {
    // BYOK and every other route with no escalation hook keep today's
    // behavior: a remembered outage on the same upstream name is irrelevant to
    // them, and their traffic must not close it either.
    const primary = primaryProvider();
    const wrapped = new RetryProvider(primary.provider);
    recordFallbackServed(UPSTREAM_ROUTE);

    const result = await wrapped.sendMessage(MESSAGES, {
      config: { callSite: "mainAgent" },
    });

    expect(result.model).toBe("primary-model");
    expect(primary.calls()).toBe(1);
    expect(shouldSkipPrimary(PRIMARY_ROUTE)).toBe(true);
  });

  test("a request pinned to an explicit model ignores an open breaker and cannot close it", async () => {
    // A pinned request can never re-route (the pin outranks any backup
    // profile), so skipping the primary would only lose it the only route it
    // has. By the same token its success says nothing about the traffic the
    // breaker was opened for, so it must not clear the trip.
    const primary = primaryProvider();
    const backup = backupProvider();
    const route = makeRoute(backup.provider);
    const wrapped = new RetryProvider(primary.provider, {
      resolveFallbackRoute: route.resolveFallbackRoute,
    });
    recordFallbackServed(UPSTREAM_ROUTE);

    const result = await wrapped.sendMessage(MESSAGES, {
      config: { callSite: "mainAgent", model: "pinned-model" },
    });

    expect(result.model).toBe("pinned-model");
    expect(primary.calls()).toBe(1);
    expect(backup.calls()).toBe(0);
    expect(shouldSkipPrimary(PRIMARY_ROUTE)).toBe(true);
  });

  test("a fallback serve trips the breaker for the next request", async () => {
    const primary = primaryProvider(
      () => new ProviderError("model not found", UPSTREAM, 404),
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

  test("a retired model diverts only itself, not a healthy model on the same upstream", async () => {
    // The retired-model incident this feature exists for must not take the
    // whole upstream down with it.
    const primary = primaryProvider(
      () => new ProviderError("model not found", UPSTREAM, 404),
    );
    const backup = backupProvider();
    const route = makeRoute(backup.provider);
    const wrapped = new RetryProvider(primary.provider, {
      resolveFallbackRoute: route.resolveFallbackRoute,
    });

    await wrapped.sendMessage(MESSAGES, { config: { callSite: "mainAgent" } });
    expect(backup.calls()).toBe(1);

    // A profile pinned to another model on the same upstream still goes to its
    // own primary.
    const healthy = await wrapped.sendMessage(MESSAGES, {
      config: { ...OTHER_MODEL_CALL },
    });
    expect(healthy.model).toBe("other-model");
    expect(primary.seenModels()).toEqual(["primary-model", "other-model"]);
    expect(backup.calls()).toBe(1);

    // The retired model itself is still remembered.
    await wrapped.sendMessage(MESSAGES, { config: { callSite: "mainAgent" } });
    expect(backup.calls()).toBe(2);
    expect(primary.calls()).toBe(2);
  });

  test("a probe that comes back with a retired model frees the rest of the upstream", async () => {
    const primary = primaryProvider(
      () => new ProviderError("model not found", UPSTREAM, 404),
    );
    const backup = backupProvider();
    const route = makeRoute(backup.provider);
    const wrapped = new RetryProvider(primary.provider, {
      resolveFallbackRoute: route.resolveFallbackRoute,
    });
    recordFallbackServed(UPSTREAM_ROUTE, Date.now() - MAX_COOLDOWN_MS - 1);

    // The probe reaches the upstream and comes back with a retired model, so
    // the outage that opened the entry is over and the retirement replaces it.
    const probed = await wrapped.sendMessage(MESSAGES, {
      config: { callSite: "mainAgent" },
    });
    expect(primary.calls()).toBe(1);
    expect(probed.model).toBe("backup-model");

    // A healthy model on the same upstream is servable again...
    const healthy = await wrapped.sendMessage(MESSAGES, {
      config: { ...OTHER_MODEL_CALL },
    });
    expect(healthy.model).toBe("other-model");

    // ...while the retired model keeps going to the backup.
    await wrapped.sendMessage(MESSAGES, { config: { callSite: "mainAgent" } });
    expect(backup.calls()).toBe(2);
    expect(primary.seenModels()).toEqual(["primary-model", "other-model"]);
  });

  test("an upstream outage diverts every model on it", async () => {
    // A managed credential rejection indicts the upstream, not one model, so
    // the healthy model is skipped too.
    const primary = primaryProvider(
      () =>
        new ProviderError("Unauthorized", UPSTREAM, 401, {
          reason: "invalid_credentials",
        }),
    );
    const backup = backupProvider();
    const route = makeRoute(backup.provider);
    const wrapped = new RetryProvider(primary.provider, {
      credentialSource: "vellum-managed",
      refreshCredentialProvider: async () => null,
      resolveFallbackRoute: route.resolveFallbackRoute,
    });

    await wrapped.sendMessage(MESSAGES, { config: { callSite: "mainAgent" } });
    expect(backup.calls()).toBe(1);

    await wrapped.sendMessage(MESSAGES, { config: { ...OTHER_MODEL_CALL } });
    expect(backup.calls()).toBe(2);
    // Only the first request ever reached the upstream.
    expect(primary.calls()).toBe(1);
  });
});
