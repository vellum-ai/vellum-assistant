import { describe, expect, test } from "bun:test";

import {
  GENERIC_AUTH_ERROR_MESSAGE,
  isUserCancelledAuthError,
  nativeAuthErrorCode,
  nativeAuthErrorDetail,
  nativeAuthErrorMessage,
} from "./native-auth-error";

/**
 * Capacitor rebuilds a native rejection as an Error carrying the plugin's
 * `code` and `data` as own properties (`CAPPluginCallError` nests the plugin's
 * dictionary under `data`; the bridge copies the payload's top-level keys onto
 * the Error). These helpers build that exact shape.
 */
function nativeRejection(code: string, data?: Record<string, unknown>): Error {
  return Object.assign(new Error("rejected"), { code, ...(data ? { data } : {}) });
}

function authErrorRejection(authError: string): Error {
  return nativeRejection("AUTH_ERROR", { authError });
}

describe("nativeAuthErrorCode", () => {
  test("reads the Capacitor rejection code", () => {
    expect(nativeAuthErrorCode(nativeRejection("USER_CANCELLED"))).toBe(
      "USER_CANCELLED",
    );
  });

  test("is undefined for a plain error and for non-objects", () => {
    expect(nativeAuthErrorCode(new Error("network down"))).toBeUndefined();
    expect(nativeAuthErrorCode("boom")).toBeUndefined();
    expect(nativeAuthErrorCode(null)).toBeUndefined();
    expect(nativeAuthErrorCode(undefined)).toBeUndefined();
  });

  test("ignores a non-string code rather than coercing it", () => {
    expect(
      nativeAuthErrorCode(Object.assign(new Error("x"), { code: 401 })),
    ).toBeUndefined();
  });
});

describe("isUserCancelledAuthError", () => {
  test("matches the dismissal code exactly", () => {
    expect(isUserCancelledAuthError(nativeRejection("USER_CANCELLED"))).toBe(
      true,
    );
  });

  test("does not match a failure that merely mentions cancellation", () => {
    expect(isUserCancelledAuthError(new Error("User cancelled login"))).toBe(
      false,
    );
    expect(isUserCancelledAuthError(authErrorRejection("signup_closed"))).toBe(
      false,
    );
  });
});

describe("nativeAuthErrorDetail", () => {
  test("returns the cause the native shell attached", () => {
    expect(nativeAuthErrorDetail(authErrorRejection("signup_closed"))).toBe(
      "signup_closed",
    );
  });

  test("is undefined unless the rejection is a classified AUTH_ERROR", () => {
    // The same `data` shape under a different code is not a classification.
    expect(
      nativeAuthErrorDetail(
        nativeRejection("USER_CANCELLED", { authError: "signup_closed" }),
      ),
    ).toBeUndefined();
    expect(nativeAuthErrorDetail(new Error("network down"))).toBeUndefined();
  });

  test("is undefined when AUTH_ERROR carries no usable cause", () => {
    expect(nativeAuthErrorDetail(nativeRejection("AUTH_ERROR"))).toBeUndefined();
    expect(
      nativeAuthErrorDetail(nativeRejection("AUTH_ERROR", {})),
    ).toBeUndefined();
    expect(
      nativeAuthErrorDetail(nativeRejection("AUTH_ERROR", { authError: "" })),
    ).toBeUndefined();
    expect(
      nativeAuthErrorDetail(nativeRejection("AUTH_ERROR", { authError: 42 })),
    ).toBeUndefined();
  });
});

describe("nativeAuthErrorMessage", () => {
  test("explains a closed signup instead of asking the user to retry", () => {
    const message = nativeAuthErrorMessage(authErrorRejection("signup_closed"));

    expect(message).not.toBe(GENERIC_AUTH_ERROR_MESSAGE);
    expect(message).toContain("vellum.ai/community");
  });

  test("explains a provider account that is not linked to an account yet", () => {
    expect(nativeAuthErrorMessage(authErrorRejection("provider_signup"))).toBe(
      "No Vellum account is linked to that login yet. Sign up first, then sign in.",
    );
  });

  test("explains a sign-in that needs a step this shell cannot run", () => {
    expect(nativeAuthErrorMessage(authErrorRejection("login_incomplete"))).toBe(
      "Your account needs another step to finish signing in. Please sign in on the web, then try again.",
    );
  });

  test("falls back to the generic message for an unmapped cause", () => {
    // allauth names its own code in a 400, so unmapped values reach here.
    expect(nativeAuthErrorMessage(authErrorRejection("some_new_code"))).toBe(
      GENERIC_AUTH_ERROR_MESSAGE,
    );
  });

  test("falls back to the generic message for an unclassified failure", () => {
    expect(nativeAuthErrorMessage(new Error("Failed to fetch"))).toBe(
      GENERIC_AUTH_ERROR_MESSAGE,
    );
    expect(nativeAuthErrorMessage(undefined)).toBe(GENERIC_AUTH_ERROR_MESSAGE);
  });
});
