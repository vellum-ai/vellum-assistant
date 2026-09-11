/**
 * Tests for `useActiveProfileModelState`, the resolution signal a caller gates
 * a capability on.
 *
 * The hook is its two queries, so `useQuery` is replaced and each read is
 * staged by the `_id` its mocked options factory carries. That is the only way
 * to hold one of them in flight, which is the state the signal exists for: a
 * null model under a loading config says nothing about the model, and a caller
 * reading it as an answer opens a gate it was asked to hold.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, renderHook } from "@testing-library/react";

type QueryState = { data?: unknown; status: "pending" | "success" | "error" };

const PENDING: QueryState = { data: undefined, status: "pending" };
const ERRORED: QueryState = { data: undefined, status: "error" };

function loaded(data: unknown): QueryState {
  return { data, status: "success" };
}

/** Staged state per query, keyed by the `_id` its options factory carries. */
let queries: Record<string, QueryState> = {};
let queryEnabled: Record<string, boolean | undefined> = {};
let orgReady = true;

const actualReactQuery = await import("@tanstack/react-query");
mock.module("@tanstack/react-query", () => ({
  ...actualReactQuery,
  useQuery: (opts: { queryKey?: [{ _id?: string }]; enabled?: boolean }) => {
    queryEnabled[opts.queryKey?.[0]?._id ?? ""] = opts.enabled;
    if (opts.enabled === false) {
      return PENDING;
    }
    return queries[opts.queryKey?.[0]?._id ?? ""] ?? PENDING;
  },
}));

function options(id: string) {
  return () => ({ queryKey: [{ _id: id }] });
}

mock.module("@/generated/daemon/@tanstack/react-query.gen", () => ({
  configGetOptions: options("config"),
  conversationsByIdGetOptions: options("conversation"),
}));

mock.module("@/hooks/use-is-org-ready", () => ({
  useIsOrgReady: () => orgReady,
}));

const { useActiveProfileModel, useActiveProfileModelState } =
  await import("@/domains/chat/hooks/use-active-profile-model");

const CONFIG = loaded({
  llm: {
    activeProfile: "global",
    profiles: {
      global: { provider: "anthropic", model: "claude", supportsVision: true },
      docs: { provider: "openai", model: "text-only", supportsVision: false },
    },
  },
});

function state(conversationId: string | undefined) {
  const { result } = renderHook(() =>
    useActiveProfileModelState("assistant-1", conversationId),
  );
  return result.current;
}

afterEach(() => {
  cleanup();
  queries = {};
  queryEnabled = {};
  orgReady = true;
});

describe("useActiveProfileModelState", () => {
  test("has resolved nothing while the config is loading", () => {
    queries = { conversation: loaded({ conversation: {} }) };
    expect(state("conv-1")).toEqual({ model: null, resolved: false });
  });

  test("resolves on the config alone with no conversation to read", () => {
    // GIVEN a config that names a vision-capable global profile
    queries = { config: CONFIG };

    // WHEN no conversation is targeted, so that query never runs
    // THEN the global profile is the answer, and it is a settled one
    expect(state(undefined)).toEqual({
      model: { provider: "anthropic", model: "claude", supportsVision: true },
      resolved: true,
    });
  });

  test("holds while the target conversation's row is still loading", () => {
    // The row carries the override, so the global profile standing in for it
    // is a guess, not the model this conversation runs.
    queries = { config: CONFIG };
    expect(state("conv-1")).toEqual({
      model: { provider: "anthropic", model: "claude", supportsVision: true },
      resolved: false,
    });
  });

  test("waits for organization headers before starting either query", () => {
    orgReady = false;
    queries = {
      config: CONFIG,
      conversation: loaded({ conversation: { inferenceProfile: "docs" } }),
    };

    expect(state("conv-1")).toEqual({ model: null, resolved: false });
    expect(queryEnabled).toEqual({ config: false, conversation: false });
  });

  test("resolves the conversation's own override once its row lands", () => {
    queries = {
      config: CONFIG,
      conversation: loaded({ conversation: { inferenceProfile: "docs" } }),
    };
    expect(state("conv-1")).toEqual({
      model: { provider: "openai", model: "text-only", supportsVision: false },
      resolved: true,
    });
  });

  test("holds while the conversation read has failed", () => {
    // A failed read says nothing about the override the row may carry, so
    // the target is not resolved, and an image gate reading it keeps holding.
    queries = { config: CONFIG, conversation: ERRORED };
    expect(state("conv-1")).toEqual({
      model: { provider: "anthropic", model: "claude", supportsVision: true },
      resolved: false,
    });
  });
});

describe("useActiveProfileModel", () => {
  test("reports the same model the state hook resolves", () => {
    queries = {
      config: CONFIG,
      conversation: loaded({ conversation: { inferenceProfile: "docs" } }),
    };
    const { result } = renderHook(() =>
      useActiveProfileModel("assistant-1", "conv-1"),
    );
    expect(result.current).toEqual({
      provider: "openai",
      model: "text-only",
      supportsVision: false,
    });
  });
});
