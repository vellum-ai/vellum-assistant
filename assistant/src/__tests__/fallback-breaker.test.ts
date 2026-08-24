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
import { UNPARSEABLE_TOOL_ARGS_SDK_MESSAGE } from "../providers/unparseable-tool-args.js";
import { ProviderError } from "../util/errors.js";
import { DEFAULT_MAX_RETRIES } from "../util/retry.js";
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
  seenMessages: () => Message[][];
} {
  const seen: (string | undefined)[] = [];
  const seenMessages: Message[][] = [];
  let calls = 0;
  const provider: Provider = {
    name: UPSTREAM,
    sendMessage: async (messages: Message[], options?: SendMessageOptions) => {
      calls += 1;
      seen.push(options?.config?.model);
      seenMessages.push(messages);
      const next = errors.shift();
      if (next) {
        throw next();
      }
      return okResponse(options?.config?.model ?? "unresolved");
    },
  };
  return {
    provider,
    calls: () => calls,
    seenModels: () => seen,
    seenMessages: () => seenMessages,
  };
}

/**
 * Backup stub that serves whatever model the re-normalized options resolved,
 * after throwing the next error from `errors` while any remain.
 */
function backupProvider(...errors: (() => unknown)[]): {
  provider: Provider;
  calls: () => number;
} {
  let calls = 0;
  const provider: Provider = {
    name: "anthropic",
    sendMessage: async (_messages: Message[], options?: SendMessageOptions) => {
      calls += 1;
      const next = errors.shift();
      if (next) {
        throw next();
      }
      return okResponse(options?.config?.model ?? "unresolved");
    },
  };
  return { provider, calls: () => calls };
}

/**
 * A transient upstream failure that names a zero wait, so a retry budget can be
 * exercised without the test sitting through real exponential backoff.
 */
function transient(status = 503): ProviderError {
  return new ProviderError("Service Unavailable", "anthropic", status, {
    retryAfterMs: 0,
  });
}

/**
 * A mid-stream corruption: the upstream accepted the request and streamed, so
 * the error carries no HTTP status. `retryAfterMs` is a test convenience only,
 * standing in for a Retry-After header this shape would not really carry, so a
 * retry budget can be counted without sitting through real backoff.
 */
function corruptedStream(): ProviderError {
  return new ProviderError(
    "stream ended without producing a message",
    UPSTREAM,
    undefined,
    { retryAfterMs: 0 },
  );
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

  test("a stale fallback serve cannot re-trip a recovered route", () => {
    const observation = recordPrimaryFailure(UPSTREAM_ROUTE, T0);
    recordPrimarySuccess(UPSTREAM_ROUTE, T0 + 1_000);

    recordFallbackServed(UPSTREAM_ROUTE, T0 + 2_000, observation);

    expect(shouldSkipPrimary(UPSTREAM_ROUTE, T0 + 2_000)).toBe(false);
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

  test("a late fallback completion cannot reopen a recovered primary", async () => {
    const primary = primaryProvider(
      () => new ProviderError("model not found", UPSTREAM, 404),
    );
    let resolveBackupStarted!: () => void;
    const backupStarted = new Promise<void>((resolve) => {
      resolveBackupStarted = resolve;
    });
    let resolveBackupResponse!: (response: ProviderResponse) => void;
    const backupResponse = new Promise<ProviderResponse>((resolve) => {
      resolveBackupResponse = resolve;
    });
    const backup: Provider = {
      name: "anthropic",
      sendMessage: async () => {
        resolveBackupStarted();
        return backupResponse;
      },
    };
    const route = makeRoute(backup);
    const wrapped = new RetryProvider(primary.provider, {
      resolveFallbackRoute: route.resolveFallbackRoute,
    });

    const first = wrapped.sendMessage(MESSAGES, {
      config: { callSite: "mainAgent" },
    });
    await backupStarted;

    // A concurrent recovery probe can prove the primary is healthy while the
    // earlier request is still waiting for its backup response.
    recordPrimarySuccess(PRIMARY_ROUTE);
    resolveBackupResponse(okResponse("backup-model"));

    await first;
    expect(shouldSkipPrimary(PRIMARY_ROUTE)).toBe(false);
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

// ── The retry budget a breaker-driven send gets on the backup ───────────────

describe("the backup's retry budget", () => {
  test("a breaker-open request retries a transient failure on the backup instead of failing the turn", async () => {
    // The breaker trips after a single successful fallback serve, so for the
    // whole cooldown every request skips the primary. Those requests spend no
    // retry budget on the way, so they get one on the backup: on a single
    // attempt a lone 429 or mid-stream cut fails the turn.
    const primary = primaryProvider();
    const backup = backupProvider(() => transient());
    const route = makeRoute(backup.provider);
    const wrapped = new RetryProvider(primary.provider, {
      resolveFallbackRoute: route.resolveFallbackRoute,
    });
    recordFallbackServed(UPSTREAM_ROUTE);

    const result = await wrapped.sendMessage(MESSAGES, {
      config: { callSite: "mainAgent" },
    });

    expect(result.model).toBe("backup-model");
    expect(backup.calls()).toBe(2);
    // The primary is still skipped entirely: the retry budget moved to the
    // backup, it was not restored to a route known to be down.
    expect(primary.calls()).toBe(0);
  });

  test("a retried backup never escalates to a second fallback", async () => {
    // One hop is structural, not a budget: the route callback is consulted
    // exactly once however many attempts the backup takes.
    const primary = primaryProvider();
    const backup = backupProvider(
      () => transient(),
      () => transient(),
      () => transient(),
      () => transient(),
    );
    const route = makeRoute(backup.provider);
    const wrapped = new RetryProvider(primary.provider, {
      resolveFallbackRoute: route.resolveFallbackRoute,
    });
    recordFallbackServed(UPSTREAM_ROUTE);

    const thrown = await captureError(
      wrapped.sendMessage(MESSAGES, { config: { callSite: "mainAgent" } }),
    );

    expect(backup.calls()).toBe(1 + DEFAULT_MAX_RETRIES);
    expect(route.calls()).toBe(1);
    expect(primary.calls()).toBe(0);
    // Tagged like the primary loop's own exhaustion, so Sentry capture reads a
    // flapping backup as noise rather than an engineering signal.
    expect((thrown as { retriesExhausted?: boolean }).retriesExhausted).toBe(
      true,
    );
  });

  test("a failed probe hands its request a retry budget on the backup too", async () => {
    // A probe is one attempt on the primary, not a retry loop, so its request
    // has spent no budget either by the time it reaches the backup.
    const primary = primaryProvider(
      () => new ProviderError("Service Unavailable", UPSTREAM, 503),
    );
    const backup = backupProvider(() => transient());
    const route = makeRoute(backup.provider);
    const wrapped = new RetryProvider(primary.provider, {
      resolveFallbackRoute: route.resolveFallbackRoute,
    });
    recordFallbackServed(UPSTREAM_ROUTE, Date.now() - MAX_COOLDOWN_MS - 1);

    const result = await wrapped.sendMessage(MESSAGES, {
      config: { callSite: "mainAgent" },
    });

    expect(primary.calls()).toBe(1);
    expect(backup.calls()).toBe(2);
    expect(result.model).toBe("backup-model");
  });

  test("an escalation after the primary burned its budget still gets one attempt", async () => {
    // The asymmetry worth keeping: this request already waited out a full
    // retry loop, so the backup answers once or the turn fails.
    const primary = primaryProvider(
      () =>
        new ProviderError("Service Unavailable", UPSTREAM, 503, {
          retryAfterMs: 0,
        }),
      () =>
        new ProviderError("Service Unavailable", UPSTREAM, 503, {
          retryAfterMs: 0,
        }),
      () =>
        new ProviderError("Service Unavailable", UPSTREAM, 503, {
          retryAfterMs: 0,
        }),
      () =>
        new ProviderError("Service Unavailable", UPSTREAM, 503, {
          retryAfterMs: 0,
        }),
    );
    const backup = backupProvider(
      () => transient(),
      () => transient(),
    );
    const route = makeRoute(backup.provider);
    const wrapped = new RetryProvider(primary.provider, {
      resolveFallbackRoute: route.resolveFallbackRoute,
    });

    await captureError(
      wrapped.sendMessage(MESSAGES, { config: { callSite: "mainAgent" } }),
    );

    expect(primary.calls()).toBe(1 + DEFAULT_MAX_RETRIES);
    expect(backup.calls()).toBe(1);
  });
});

// ── What a failed probe is allowed to conclude ──────────────────────────────

describe("recovery probe verdicts", () => {
  test("a probe that fails with a corrupted stream closes the breaker and still completes the turn", async () => {
    // Every stream-corruption pattern requires an absent HTTP status, which
    // means the upstream accepted the request, returned 200, and streamed. The
    // failure is in the bytes it produced, not in its ability to serve, so it
    // is evidence the primary is healthy. The verdict must not cost the request
    // that established it: this is exactly the failure the main loop repairs by
    // resending, so the probe hands the request back to that loop.
    const primary = primaryProvider(() => corruptedStream());
    const backup = backupProvider();
    const route = makeRoute(backup.provider);
    const wrapped = new RetryProvider(primary.provider, {
      resolveFallbackRoute: route.resolveFallbackRoute,
    });
    recordFallbackServed(UPSTREAM_ROUTE, Date.now() - MAX_COOLDOWN_MS - 1);

    const result = await wrapped.sendMessage(MESSAGES, {
      config: { callSite: "mainAgent" },
    });

    // The turn completed on the route the probe just cleared.
    expect(result.model).toBe("primary-model");
    expect(primary.calls()).toBe(2);
    expect(backup.calls()).toBe(0);
    // The breaker closed rather than re-tripping with a doubled cooldown, so
    // the next request takes the primary and gets its full retry budget.
    expect(shouldSkipPrimary(PRIMARY_ROUTE)).toBe(false);
  });

  test("a corrupted-stream probe leaves the request the same total budget as one that never probes", async () => {
    // The probe's send counts as this request's first attempt, so continuing
    // into the retry loop must not hand it a wider budget than a request that
    // never probes. Four sends total, then the backup as the loop's ordinary
    // last resort, so the turn finishes even when the primary never stops
    // corrupting.
    const primary = primaryProvider(
      () => corruptedStream(),
      () => corruptedStream(),
      () => corruptedStream(),
      () => corruptedStream(),
      () => corruptedStream(),
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

    expect(primary.calls()).toBe(1 + DEFAULT_MAX_RETRIES);
    expect(result.model).toBe("backup-model");
    // A backup that had to serve is proof the route is down after all, so the
    // breaker is remembered again on the way out.
    expect(shouldSkipPrimary(PRIMARY_ROUTE)).toBe(true);
  });

  test("a probe that spent a corrective resend keeps the same total budget", async () => {
    // The repaired path: the probe sends twice (the original plus the
    // corrective resend) before the stream corruption hands the request to the
    // retry loop. The seed has to count both, or this request makes one more
    // primary send than a request that never probes.
    const primary = primaryProvider(
      () =>
        new ProviderError(
          `Anthropic: ${UNPARSEABLE_TOOL_ARGS_SDK_MESSAGE}`,
          UPSTREAM,
          undefined,
        ),
      () => corruptedStream(),
      () => corruptedStream(),
      () => corruptedStream(),
      () => corruptedStream(),
      () => corruptedStream(),
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

    // Two probe sends plus two loop sends, not two plus three.
    expect(primary.calls()).toBe(1 + DEFAULT_MAX_RETRIES);
    expect(result.model).toBe("backup-model");
  });

  test("a probe repairs malformed tool arguments instead of reporting an outage", async () => {
    // The main retry loop repairs this deterministically with a corrective
    // note; the probe gets the same one-shot repair rather than reading a
    // request-conditioned failure as the route still being down.
    const primary = primaryProvider(
      () =>
        new ProviderError(
          `Anthropic: ${UNPARSEABLE_TOOL_ARGS_SDK_MESSAGE}`,
          UPSTREAM,
          undefined,
        ),
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

    expect(result.model).toBe("primary-model");
    expect(primary.calls()).toBe(2);
    expect(backup.calls()).toBe(0);
    // The resend carried the corrective note, which is the whole point of it.
    const resent = primary.seenMessages()[1];
    const tail = resent[resent.length - 1].content;
    expect(JSON.stringify(tail)).toContain("[assistant runtime]");
    expect(shouldSkipPrimary(PRIMARY_ROUTE)).toBe(false);
  });

  test("a probe rate-limited by the primary still reads the outage as continuing", async () => {
    // Deliberately not treated like a stream corruption. A 429 is the route
    // refusing to do the work: no resend repairs it, only waiting does, and
    // that is exactly what the cooldown provides. Reading it as recovery would
    // send every request back to a primary that rejects all of them.
    const primary = primaryProvider(
      () => new ProviderError("Too Many Requests", UPSTREAM, 429),
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

    // Exactly one attempt on a route just judged down: the request goes
    // straight to the backup rather than spending a retry budget on it.
    expect(primary.calls()).toBe(1);
    expect(backup.calls()).toBe(1);
    expect(result.model).toBe("backup-model");
    expect(shouldSkipPrimary(PRIMARY_ROUTE)).toBe(true);
  });

  test("a probe that fails with a 5xx still extends the outage", async () => {
    // The control for the two cases above: a genuine server error is what the
    // breaker exists to remember, and it must keep re-tripping.
    const primary = primaryProvider(
      () => new ProviderError("Service Unavailable", UPSTREAM, 503),
    );
    const backup = backupProvider();
    const route = makeRoute(backup.provider);
    const wrapped = new RetryProvider(primary.provider, {
      resolveFallbackRoute: route.resolveFallbackRoute,
    });
    const trippedAt = Date.now() - MAX_COOLDOWN_MS - 1;
    recordFallbackServed(UPSTREAM_ROUTE, trippedAt);

    const result = await wrapped.sendMessage(MESSAGES, {
      config: { callSite: "mainAgent" },
    });

    expect(result.model).toBe("backup-model");
    // No extra attempts on the primary either: an outage verdict fails fast
    // into the backup instead of continuing into the retry loop.
    expect(primary.calls()).toBe(1);
    expect(shouldSkipPrimary(PRIMARY_ROUTE)).toBe(true);
    // A failed probe doubles the wait, so the re-trip lands above the base.
    expectWithinJitterBand(
      observedCooldownMs(UPSTREAM_ROUTE, Date.now()),
      BASE_COOLDOWN_MS * 2,
    );
  });
});

// ── What counts as having spent the retry budget ────────────────────────────

describe("retry exhaustion accounting", () => {
  /**
   * The primary of a probe that uses both of its repairs before failing for
   * real. The first send is rejected as an expired managed credential, the
   * refreshed adapter answers the resend with malformed tool arguments, and the
   * corrective resend after that comes back as a stream corruption. Three sends
   * are spent by the time the request reaches the ordinary loop, leaving it
   * exactly one, which it spends on `lastError`.
   */
  function repairedProbeAdapters(lastError: () => unknown): {
    primary: ReturnType<typeof primaryProvider>;
    refreshed: ReturnType<typeof primaryProvider>;
  } {
    return {
      primary: primaryProvider(
        () =>
          new ProviderError("Unauthorized", UPSTREAM, 401, {
            reason: "invalid_credentials",
          }),
      ),
      refreshed: primaryProvider(
        () =>
          new ProviderError(
            `Anthropic: ${UNPARSEABLE_TOOL_ARGS_SDK_MESSAGE}`,
            UPSTREAM,
            undefined,
          ),
        () => corruptedStream(),
        lastError,
      ),
    };
  }

  test("a probe that spends the whole budget on repairs still reaches the backup", async () => {
    // Exhaustion decides escalation eligibility, not just Sentry suppression,
    // so a request whose budget was consumed inside the probe has to be seen as
    // exhausted. Otherwise the turn this feature exists to rescue fails while a
    // healthy backup sits unused.
    const { primary, refreshed } = repairedProbeAdapters(() =>
      corruptedStream(),
    );
    const backup = backupProvider();
    const route = makeRoute(backup.provider);
    const wrapped = new RetryProvider(primary.provider, {
      credentialSource: "vellum-managed",
      refreshCredentialProvider: async () => refreshed.provider,
      resolveFallbackRoute: route.resolveFallbackRoute,
    });
    recordFallbackServed(UPSTREAM_ROUTE, Date.now() - MAX_COOLDOWN_MS - 1);

    const result = await wrapped.sendMessage(MESSAGES, {
      config: { callSite: "mainAgent" },
    });

    expect(result.model).toBe("backup-model");
    expect(backup.calls()).toBe(1);
    // One send on the original adapter plus three on the refreshed one: the
    // budget, spent exactly once.
    expect(primary.calls() + refreshed.calls()).toBe(1 + DEFAULT_MAX_RETRIES);
    expect(refreshed.calls()).toBe(3);
  });

  test("a probe that spends the whole budget on repairs tags the error as exhausted", async () => {
    // The same sequence with no backup available, so the error surfaces and its
    // tag can be read. Untagged, this is a Sentry capture for a flap the retry
    // loop already did everything about.
    const { primary, refreshed } = repairedProbeAdapters(() =>
      corruptedStream(),
    );
    const wrapped = new RetryProvider(primary.provider, {
      credentialSource: "vellum-managed",
      refreshCredentialProvider: async () => refreshed.provider,
      resolveFallbackRoute: async () => null,
    });
    recordFallbackServed(UPSTREAM_ROUTE, Date.now() - MAX_COOLDOWN_MS - 1);

    const thrown = await captureError(
      wrapped.sendMessage(MESSAGES, { config: { callSite: "mainAgent" } }),
    );

    expect((thrown as { retriesExhausted?: boolean }).retriesExhausted).toBe(
      true,
    );
    expect(primary.calls() + refreshed.calls()).toBe(1 + DEFAULT_MAX_RETRIES);
  });

  test("a request that spends its budget in the ordinary loop is exhausted", async () => {
    // The control for a request that never probes: unchanged behavior, tagged
    // and escalated after the full budget.
    const primary = primaryProvider(
      () => transient(),
      () => transient(),
      () => transient(),
      () => transient(),
    );
    const backup = backupProvider();
    const route = makeRoute(backup.provider);
    const wrapped = new RetryProvider(primary.provider, {
      resolveFallbackRoute: route.resolveFallbackRoute,
    });

    const result = await wrapped.sendMessage(MESSAGES, {
      config: { callSite: "mainAgent" },
    });

    expect(primary.calls()).toBe(1 + DEFAULT_MAX_RETRIES);
    expect(result.model).toBe("backup-model");
  });

  test("a request that fails on a non-retryable error is not exhausted", async () => {
    // The other control: one attempt, no budget spent, so nothing is tagged and
    // a plain request failure never counts as an outage.
    const primary = primaryProvider(
      () => new ProviderError("invalid request", UPSTREAM, 400),
    );
    const backup = backupProvider();
    const route = makeRoute(backup.provider);
    const wrapped = new RetryProvider(primary.provider, {
      resolveFallbackRoute: route.resolveFallbackRoute,
    });

    const thrown = await captureError(
      wrapped.sendMessage(MESSAGES, { config: { callSite: "mainAgent" } }),
    );

    expect(
      (thrown as { retriesExhausted?: boolean }).retriesExhausted,
    ).toBeUndefined();
    expect(primary.calls()).toBe(1);
    expect(backup.calls()).toBe(0);
  });
});
