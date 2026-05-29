/**
 * Unit tests for `useAssistantQuery`'s polling-cadence policy.
 *
 * The query's `refetchInterval` decides whether to keep polling based
 * on the cached lifecycle phase. We test the decision function in
 * isolation against fabricated `GetAssistantResult`s so we don't have
 * to spin a React tree just to verify "stops polling when the
 * assistant settles."
 */

import { describe, expect, test } from "bun:test";

import { resolveAssistantLifecycleState } from "@/assistant/lifecycle";
import type { GetAssistantResult } from "@/assistant/api";

const POLL_INTERVAL_MS = 3000;

function decidePollInterval(
  result: GetAssistantResult | undefined,
): number | false {
  if (!result) return false;
  const phase = resolveAssistantLifecycleState(result);
  return phase.kind === "initializing" || phase.kind === "cleaning_up"
    ? POLL_INTERVAL_MS
    : false;
}

function okResult(
  status: "active" | "initializing" | "to_be_deleted",
  isLocal = false,
): GetAssistantResult {
  return {
    ok: true,
    status: 200,
    data: {
      id: "asst-1",
      status,
      is_local: isLocal,
      maintenance_mode: { enabled: false },
    } as never,
  };
}

describe("useAssistantQuery polling cadence", () => {
  test("does not poll while the result is undefined (query hasn't resolved)", () => {
    expect(decidePollInterval(undefined)).toBe(false);
  });

  test("polls every 3s while the assistant is initializing", () => {
    expect(decidePollInterval(okResult("initializing"))).toBe(POLL_INTERVAL_MS);
  });

  test("polls every 3s while the assistant is cleaning up", () => {
    expect(decidePollInterval(okResult("to_be_deleted"))).toBe(
      POLL_INTERVAL_MS,
    );
  });

  test("stops polling once the assistant is active", () => {
    expect(decidePollInterval(okResult("active"))).toBe(false);
  });

  test("stops polling for self-hosted active (is_local=true)", () => {
    // Self-hosted assistants resolve to `kind: "self_hosted"`, which
    // is a stable phase — no need to keep polling.
    expect(decidePollInterval(okResult("active", true))).toBe(false);
  });

  test("stops polling on 404 (auto_hatch phase — recovery is mutation-driven)", () => {
    // 404 routes to `auto_hatch`, which the lifecycle hook resolves by
    // firing a hatch mutation. The poll has nothing useful to add
    // while we're waiting for the mutation to land.
    const notFound: GetAssistantResult = {
      ok: false,
      status: 404,
      error: {},
    };
    expect(decidePollInterval(notFound)).toBe(false);
  });

  test("stops polling on terminal error", () => {
    const errored: GetAssistantResult = {
      ok: false,
      status: 500,
      error: { message: "Server error" },
    };
    expect(decidePollInterval(errored)).toBe(false);
  });
});
