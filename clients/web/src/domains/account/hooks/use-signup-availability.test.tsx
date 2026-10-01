/**
 * The hook maps allauth's `account.is_open_for_signup` onto the sign-up
 * page's three states, and fails open whenever the answer is not a definite
 * "closed".
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, renderHook, waitFor } from "@testing-library/react";

import * as allauthClient from "@/lib/auth/allauth-client";
import type {
  AllauthResult,
  AuthConfiguration,
} from "@/lib/auth/allauth-client";

const authConfig = {
  result: null as AllauthResult<AuthConfiguration> | null,
  /** When set, the probe never settles. */
  stalled: false,
  calls: 0,
};

mock.module("@/lib/auth/allauth-client", () => ({
  ...allauthClient,
  getAuthConfig: () => {
    authConfig.calls += 1;
    if (authConfig.stalled) {
      return new Promise<never>(() => {});
    }
    return authConfig.result
      ? Promise.resolve(authConfig.result)
      : Promise.reject(new Error("offline"));
  },
}));

const { useSignupAvailability } =
  await import("@/domains/account/hooks/use-signup-availability");

const configReporting = (
  isOpenForSignup: boolean,
): AllauthResult<AuthConfiguration> => ({
  ok: true,
  data: { account: { is_open_for_signup: isOpenForSignup } },
});

describe("useSignupAvailability", () => {
  beforeEach(() => {
    authConfig.result = null;
    authConfig.stalled = false;
    authConfig.calls = 0;
  });

  afterEach(cleanup);

  test("starts pending", () => {
    authConfig.result = configReporting(true);
    const { result } = renderHook(() => useSignupAvailability());

    expect(result.current).toBe("pending");
  });

  test("closes when the platform reports signups are not open", async () => {
    authConfig.result = configReporting(false);
    const { result } = renderHook(() => useSignupAvailability());

    await waitFor(() => expect(result.current).toBe("closed"));
  });

  test("opens when the platform reports signups are open", async () => {
    authConfig.result = configReporting(true);
    const { result } = renderHook(() => useSignupAvailability());

    await waitFor(() => expect(result.current).toBe("open"));
  });

  test("fails open on an error response", async () => {
    authConfig.result = { ok: false, status: 500, errors: [] };
    const { result } = renderHook(() => useSignupAvailability());

    await waitFor(() => expect(result.current).toBe("open"));
  });

  test("fails open when the request rejects", async () => {
    const { result } = renderHook(() => useSignupAvailability());

    await waitFor(() => expect(result.current).toBe("open"));
  });

  test("fails open when the probe stalls past the deadline", async () => {
    authConfig.stalled = true;
    const { result } = renderHook(() =>
      useSignupAvailability({ timeoutMs: 10 }),
    );

    await waitFor(() => expect(result.current).toBe("open"));
  });

  test("does not probe when disabled", () => {
    authConfig.result = configReporting(false);
    const { result } = renderHook(() =>
      useSignupAvailability({ enabled: false }),
    );

    expect(result.current).toBe("pending");
    expect(authConfig.calls).toBe(0);
  });
});
