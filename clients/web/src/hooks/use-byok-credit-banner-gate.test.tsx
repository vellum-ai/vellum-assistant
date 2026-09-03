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
 * The `suppress` value asserted in each case is the one the hook returned when
 * it was a bare boolean, so the matrix is the record that the banner path did
 * not move.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { renderHook } from "@testing-library/react";

type QueryState = { data?: unknown; isLoading?: boolean; isError?: boolean };

const IDLE: QueryState = { data: undefined, isLoading: false, isError: false };
const LOADING: QueryState = {
  data: undefined,
  isLoading: true,
  isError: false,
};

/** Staged state per query, keyed by the `_id` its options factory carries. */
let queries: Record<string, QueryState> = {};

const actualReactQuery = await import("@tanstack/react-query");
mock.module("@tanstack/react-query", () => ({
  ...actualReactQuery,
  useQuery: (opts: { queryKey?: [{ _id?: string }]; enabled?: boolean }) => {
    const id = opts.queryKey?.[0]?._id ?? "";
    // A disabled query is pending with an idle fetch, so `isLoading` is false
    // and no data arrives. That shape is the whole point of the "cannot ask
    // yet" branch, so the double has to reproduce it rather than smooth it
    // over.
    if (opts.enabled === false) {
      return IDLE;
    }
    return { ...IDLE, ...(queries[id] ?? IDLE) };
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
    config: { data: { llm: {} } },
    connections: { data: { connections: [] } },
    profiles: { data: { profiles: [] } },
    defaultProvider: { data: { availability: { status: "available" } } },
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
    expect(v).toEqual({ suppress: false, settled: true });
  });

  test("queries in flight suppress, and say so", () => {
    queries = { config: LOADING };
    const v = verdict();
    // The banner's fail-safe: an unknown route must not raise a false alarm.
    expect(v).toEqual({ suppress: true, settled: false });
  });

  test("no resolved assistant is not-asked-yet, not answered-no", () => {
    // The regression this hook's shape exists for. Every route query is
    // disabled without an assistant, so the fail-open verdict below rests on
    // nothing; reading it as a settled "route spends the wallet" is what let
    // the usage panel claim extra credits before it had asked anything.
    assistantId = null;
    const v = verdict();
    expect(v).toEqual({ suppress: false, settled: false });
  });

  test("a managed route is a settled answer", () => {
    answerRouteQueries();
    burnsManaged = true;
    const v = verdict();
    expect(v).toEqual({ suppress: false, settled: true });
  });

  test("a version-gated query the assistant is too old for still settles", () => {
    // The gate answered "no" rather than "not yet": that query is never
    // coming, so waiting on it would hold the verdict open forever.
    answerRouteQueries();
    supportsProfiles = false;
    supportsDefaultProvider = false;
    const v = verdict();
    expect(v).toEqual({ suppress: false, settled: true });
  });

  test("a BYOK route waits for the spend probe before settling", () => {
    answerRouteQueries();
    burnsManaged = false;
    queries = { ...queries, totals: LOADING };
    const v = verdict();
    expect(v).toEqual({ suppress: true, settled: false });
  });

  test("a BYOK route with no recent burn suppresses, settled", () => {
    answerRouteQueries();
    burnsManaged = false;
    queries = { ...queries, totals: { data: { total_usd: "0.00" } } };
    const v = verdict();
    expect(v).toEqual({ suppress: true, settled: true });
  });

  test("a recent managed burn re-arms the banners", () => {
    answerRouteQueries();
    burnsManaged = false;
    queries = { ...queries, totals: { data: { total_usd: "1.25" } } };
    const v = verdict();
    expect(v).toEqual({ suppress: false, settled: true });
  });

  test("a failed spend probe fails open, and that is a final answer", () => {
    answerRouteQueries();
    burnsManaged = false;
    queries = { ...queries, totals: { isError: true } };
    const v = verdict();
    expect(v).toEqual({ suppress: false, settled: true });
  });
});
