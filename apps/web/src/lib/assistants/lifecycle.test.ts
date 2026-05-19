import { describe, expect, test } from "bun:test";

import type { GetAssistantResult } from "@/lib/assistants/api.js";
import {
  buildInitializingTimeoutError,
  INITIALIZING_TIMEOUT_MS,
  isPlatformHostedDisabled,
  PLATFORM_HOSTED_DISABLED_CODE,
  PLATFORM_HOSTED_DISABLED_MESSAGE,
  resolveAssistantLifecycleState,
  shouldRecoverFromHatchFailure,
} from "@/lib/assistants/lifecycle.js";

function makeCurrentResult(
  status: string,
  overrides: Record<string, unknown> = {},
): GetAssistantResult {
  return {
    ok: true,
    status: 200,
    data: {
      id: "assistant-1",
      name: "New Assistant",
      description: null,
      status,
      created: "2024-01-01T00:00:00Z",
      modified: "2024-01-01T00:00:00Z",
      machine_id: null,
      current_release_version: null,
      is_local: false,
      ...overrides,
    },
  } as GetAssistantResult;
}

describe("resolveAssistantLifecycleState", () => {
  test("maps active assistants to active state", () => {
    expect(resolveAssistantLifecycleState(makeCurrentResult("active"))).toEqual({
      kind: "active",
    });
  });

  test("maps active self-hosted assistants to self_hosted state", () => {
    expect(
      resolveAssistantLifecycleState(
        makeCurrentResult("active", { is_local: true }),
      ),
    ).toEqual({ kind: "self_hosted" });
  });

  test("maps initializing assistants to initializing state", () => {
    expect(
      resolveAssistantLifecycleState(makeCurrentResult("initializing")),
    ).toEqual({ kind: "initializing" });
  });

  test("maps to_be_deleted assistants to cleaning_up state", () => {
    expect(
      resolveAssistantLifecycleState(makeCurrentResult("to_be_deleted")),
    ).toEqual({ kind: "cleaning_up" });
  });

  test("maps unknown statuses to error with the offending value", () => {
    const state = resolveAssistantLifecycleState(
      makeCurrentResult("unknown_status"),
    );
    expect(state.kind).toBe("error");
    if (state.kind === "error") {
      expect(state.message).toContain("unknown_status");
    }
  });

  test("maps 404 responses to auto_hatch", () => {
    const result = {
      ok: false,
      status: 404,
      error: { detail: "No assistant found." },
    } as GetAssistantResult;

    expect(resolveAssistantLifecycleState(result)).toEqual({
      kind: "auto_hatch",
    });
  });

  test("surfaces non-404 failures as errors", () => {
    const result = {
      ok: false,
      status: 502,
      error: { detail: "Failed to provision assistant." },
    } as GetAssistantResult;

    expect(resolveAssistantLifecycleState(result)).toEqual({
      kind: "error",
      message: "Failed to provision assistant.",
    });
  });

  test("falls back to a generic message when error has no detail", () => {
    const result = {
      ok: false,
      status: 500,
      error: {},
    } as GetAssistantResult;

    const state = resolveAssistantLifecycleState(result);
    expect(state.kind).toBe("error");
  });
});

describe("shouldRecoverFromHatchFailure", () => {
  test("treats server failures as recoverable", () => {
    expect(shouldRecoverFromHatchFailure(502)).toBe(true);
  });

  test("treats missing responses as recoverable", () => {
    expect(shouldRecoverFromHatchFailure()).toBe(true);
  });

  test("treats client failures as terminal", () => {
    expect(shouldRecoverFromHatchFailure(400)).toBe(false);
  });
});

describe("isPlatformHostedDisabled", () => {
  test("matches 503 responses tagged with the platform_hosted_disabled code", () => {
    expect(
      isPlatformHostedDisabled(503, {
        detail: "Hatching new managed assistants is temporarily disabled.",
        code: PLATFORM_HOSTED_DISABLED_CODE,
      }),
    ).toBe(true);
  });

  test("ignores non-503 statuses even with the same code", () => {
    // Defensive: the backend currently only emits this code on 503, but the
    // helper still gates on the status to avoid mistaking a future reuse
    // (e.g. a 403 with the same code) for the at-capacity signal.
    expect(
      isPlatformHostedDisabled(403, {
        code: PLATFORM_HOSTED_DISABLED_CODE,
      }),
    ).toBe(false);
  });

  test("ignores 503 responses without the code (generic upstream 503s)", () => {
    expect(isPlatformHostedDisabled(503, { detail: "Bad Gateway." })).toBe(
      false,
    );
    expect(isPlatformHostedDisabled(503, undefined)).toBe(false);
  });

  test("exposes the user-facing capacity message", () => {
    expect(PLATFORM_HOSTED_DISABLED_MESSAGE).toContain("at capacity");
    expect(PLATFORM_HOSTED_DISABLED_MESSAGE).toContain(
      "Vellum Managed Assistants",
    );
  });
});

describe("initializing timeout", () => {
  test("INITIALIZING_TIMEOUT_MS is 300 seconds", () => {
    expect(INITIALIZING_TIMEOUT_MS).toBe(300_000);
  });

  test("buildInitializingTimeoutError returns an actionable error state", () => {
    const state = buildInitializingTimeoutError();
    expect(state.kind).toBe("error");
    expect(state.message).toContain("taking longer than expected");
    // generic-examples:ignore-next-line — reason: testing real product support email shown to users
    expect(state.message).toContain("support@vellum.ai");
  });
});
