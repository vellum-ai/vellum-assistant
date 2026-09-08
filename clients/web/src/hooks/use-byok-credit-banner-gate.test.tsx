/**
 * Tests for the BYOK credit-route gate.
 *
 * The hook's own queries are what it is made of, so `useQuery` is replaced and
 * each of the six reads is staged by the `_id` its mocked options factory
 * carries. That is the only way to hold a query in flight, which is the state
 * this suite exists for: `suppress` alone cannot distinguish a route that
 * provably skips the wallet from one that has not been classified yet, and a
 * caller reading it inverted turns that gap into a false claim.
 *
 * The matrix below is the suppression contract in full: every branch that can
 * produce a verdict, and the `settled` each one carries.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { renderHook } from "@testing-library/react";

type Phase = "idle" | "fetching" | "paused" | "success" | "error";

/**
 * The flags TanStack reports for a phase, derived rather than listed so the
 * double cannot drift from the real thing. The two that carry the weight:
 * `isLoading` is pending AND fetching, so a paused fetch does not set it, and
 * a disabled query is pending at an idle fetch, so it does not either. The
 * gate has to tell those two apart.
 */
function queryState(phase: Phase, data?: unknown) {
  const fetchStatus =
    phase === "fetching" ? "fetching" : phase === "paused" ? "paused" : "idle";
  const isPending =
    phase === "idle" || phase === "fetching" || phase === "paused";
  return {
    data: phase === "success" ? data : undefined,
    fetchStatus,
    isPending,
    isError: phase === "error",
    isLoading: isPending && fetchStatus === "fetching",
  };
}

/** Enabled, but parked by the default network mode with the browser offline. */
const PAUSED = queryState("paused");
const LOADING = queryState("fetching");
/** Disabled: pending forever, and never going to fetch. */
const DISABLED = queryState("idle");

/** Staged state per query, keyed by the `_id` its options factory carries. */
let queries: Record<string, ReturnType<typeof queryState>> = {};

const actualReactQuery = await import("@tanstack/react-query");
mock.module("@tanstack/react-query", () => ({
  ...actualReactQuery,
  useQuery: (opts: { queryKey?: [{ _id?: string }]; enabled?: boolean }) => {
    const id = opts.queryKey?.[0]?._id ?? "";
    if (opts.enabled === false) {
      return DISABLED;
    }
    return queries[id] ?? DISABLED;
  },
}));

function options(id: string) {
  return () => ({ queryKey: [{ _id: id }] });
}

mock.module("@/generated/daemon/@tanstack/react-query.gen", () => ({
  configGetOptions: options("config"),
  configLlmDefaultproviderGetOptions: options("defaultProvider"),
  conversationsByIdGetOptions: options("conversation"),
  inferenceProfilesGetOptions: options("profiles"),
  inferenceProviderconnectionsGetOptions: options("connections"),
}));

mock.module("@/generated/api/@tanstack/react-query.gen", () => ({
  organizationsBillingUsageTotalsRetrieveOptions: options("totals"),
}));

let assistantId: string | null = "assistant-1";
mock.module("@/stores/resolved-assistants-store", () => ({
  useResolvedAssistantsStore: {
    use: { activeAssistantId: () => assistantId },
  },
}));

let supportsProfiles = true;
let supportsDefaultProvider = true;
mock.module("@/lib/backwards-compat/use-supports-inference-profiles", () => ({
  useSupportsInferenceProfiles: () => supportsProfiles,
}));
mock.module("@/lib/backwards-compat/default-provider-settings", () => ({
  useSupportsDefaultProviderSettings: () => supportsDefaultProvider,
}));

// The route classifier itself is covered by its own suite; what this hook
// owns is which of its answers reaches a caller, and when.
let burnsManaged = true;
mock.module("@/lib/billing/byok-credit-route", () => ({
  defaultChatRouteBurnsManagedCredits: () => burnsManaged,
}));

const { useByokCreditRouteVerdict } =
  await import("./use-byok-credit-banner-gate");

function verdict(candidate = true, conversationId: string | null = null) {
  const { result } = renderHook(() =>
    useByokCreditRouteVerdict(candidate, conversationId),
  );
  return result.current;
}

/** Every route query answered, so only the classifier's verdict is left. */
function answerRouteQueries() {
  queries = {
    config: queryState("success", { llm: {} }),
    connections: queryState("success", { connections: [] }),
    profiles: queryState("success", { profiles: [] }),
    defaultProvider: queryState("success", {
      availability: { status: "available" },
    }),
  };
}

beforeEach(() => {
  queries = {};
  assistantId = "assistant-1";
  supportsProfiles = true;
  supportsDefaultProvider = true;
  burnsManaged = true;
});

describe("useByokCreditRouteVerdict", () => {
  test("nothing to classify settles immediately", () => {
    const v = verdict(false);
    expect(v).toEqual({
      suppress: false,
      settled: true,
      routeBurnsManaged: false,
    });
  });

  test("queries in flight suppress, and say so", () => {
    queries = { config: LOADING };
    const v = verdict();
    // The banner's fail-safe: an unknown route must not raise a false alarm.
    expect(v).toEqual({
      suppress: true,
      settled: false,
      routeBurnsManaged: false,
    });
  });

  test("no resolved assistant is not-asked-yet, not answered-no", () => {
    // Every route query is disabled without an assistant, so the fail-open
    // verdict rests on nothing. A caller that read it as settled would claim
    // a managed route on evidence the gate has not gathered.
    assistantId = null;
    const v = verdict();
    expect(v).toEqual({
      suppress: false,
      settled: false,
      routeBurnsManaged: false,
    });
  });

  test("a managed route is a settled answer", () => {
    answerRouteQueries();
    burnsManaged = true;
    const v = verdict();
    expect(v).toEqual({
      suppress: false,
      settled: true,
      routeBurnsManaged: true,
    });
  });

  test("a version-gated query the assistant is too old for still settles", () => {
    // The gate answered "no" rather than "not yet": that query is never
    // coming, so waiting on it would hold the verdict open forever.
    answerRouteQueries();
    supportsProfiles = false;
    supportsDefaultProvider = false;
    const v = verdict();
    expect(v).toEqual({
      suppress: false,
      settled: true,
      routeBurnsManaged: true,
    });
  });

  test("a BYOK route waits for the spend probe before settling", () => {
    answerRouteQueries();
    burnsManaged = false;
    queries = { ...queries, totals: LOADING };
    const v = verdict();
    expect(v).toEqual({
      suppress: true,
      settled: false,
      routeBurnsManaged: false,
    });
  });

  test("a BYOK route with no recent burn suppresses, settled", () => {
    answerRouteQueries();
    burnsManaged = false;
    queries = {
      ...queries,
      totals: queryState("success", { total_usd: "0.00" }),
    };
    const v = verdict();
    expect(v).toEqual({
      suppress: true,
      settled: true,
      routeBurnsManaged: false,
    });
  });

  test("a recent managed burn re-arms the banners without making it managed", () => {
    // Spend on another surface lowers suppression. It says nothing about
    // where this conversation's next turn dispatches, so the route stays
    // BYOK and no claim may be built on it.
    answerRouteQueries();
    burnsManaged = false;
    queries = {
      ...queries,
      totals: queryState("success", { total_usd: "1.25" }),
    };
    const v = verdict();
    expect(v).toEqual({
      suppress: false,
      settled: true,
      routeBurnsManaged: false,
    });
  });

  test("a failed route read is final without being a route", () => {
    // Fail-open is the right answer for the banner, and no answer at all for
    // a caller about to tell someone their next turn spends managed credits.
    answerRouteQueries();
    queries = { ...queries, config: queryState("error") };
    expect(verdict()).toEqual({
      suppress: false,
      settled: true,
      routeBurnsManaged: false,
    });
  });

  test("an offline paused route read is unsettled", () => {
    // The default network mode parks an enabled fetch without ever reporting
    // a load or an error, so the gate has no route evidence and must not let
    // a caller paint one.
    answerRouteQueries();
    queries = { ...queries, connections: PAUSED };
    expect(verdict()).toEqual({
      suppress: false,
      settled: false,
      routeBurnsManaged: false,
    });
  });

  test("an offline paused spend probe is unsettled", () => {
    answerRouteQueries();
    burnsManaged = false;
    queries = { ...queries, totals: PAUSED };
    expect(verdict()).toEqual({
      suppress: true,
      settled: false,
      routeBurnsManaged: false,
    });
  });

  test("a failed spend probe fails open, and that is a final answer", () => {
    answerRouteQueries();
    burnsManaged = false;
    queries = { ...queries, totals: queryState("error") };
    const v = verdict();
    expect(v).toEqual({
      suppress: false,
      settled: true,
      routeBurnsManaged: false,
    });
  });
});
