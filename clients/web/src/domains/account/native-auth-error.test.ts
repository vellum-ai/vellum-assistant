import { describe, expect, test } from "bun:test";

import {
  GENERIC_AUTH_ERROR_KEY,
  isUserCancelledAuthError,
  nativeAuthErrorCode,
  nativeAuthErrorDetail,
  nativeAuthErrorKey,
} from "./native-auth-error";

/**
 * Capacitor rebuilds a native rejection as an Error carrying the plugin's
 * `code` and `data` as own properties (`CAPPluginCallError` nests the plugin's
 * dictionary under `data`; the bridge copies the payload's top-level keys onto
 * the Error). These helpers build that exact shape.
 */
function nativeRejection(code: string, data?: Record<string, unknown>): Error {
  return Object.assign(new Error("rejected"), {
    code,
    ...(data ? { data } : {}),
  });
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
    expect(
      nativeAuthErrorDetail(nativeRejection("AUTH_ERROR")),
    ).toBeUndefined();
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

describe("nativeAuthErrorKey", () => {
  test("names the closed-signup message instead of the retry one", () => {
    // The copy itself now lives in the account catalog, so what this module
    // owns is the mapping: a known cause must not collapse to the generic key.
    expect(nativeAuthErrorKey(authErrorRejection("signup_closed"))).toBe(
      "authErrors.signupClosed",
    );
  });

  test("explains a provider account that is not linked to an account yet", () => {
    expect(nativeAuthErrorKey(authErrorRejection("provider_signup"))).toBe(
      "authErrors.providerSignup",
    );
  });

  test("explains a sign-in that needs a step this shell cannot run", () => {
    expect(nativeAuthErrorKey(authErrorRejection("login_incomplete"))).toBe(
      "authErrors.loginIncomplete",
    );
  });

  test("asks an unsupported desktop shell to update", () => {
    expect(
      nativeAuthErrorKey(authErrorRejection("desktop_update_required")),
    ).toBe("authErrors.desktopUpdateRequired");
  });

  test("falls back to the generic message for an unmapped cause", () => {
    // allauth names its own code in a 400, so unmapped values reach here.
    expect(nativeAuthErrorKey(authErrorRejection("some_new_code"))).toBe(
      GENERIC_AUTH_ERROR_KEY,
    );
  });

  test("falls back to the generic message for an unclassified failure", () => {
    expect(nativeAuthErrorKey(new Error("Failed to fetch"))).toBe(
      GENERIC_AUTH_ERROR_KEY,
    );
    expect(nativeAuthErrorKey(undefined)).toBe(GENERIC_AUTH_ERROR_KEY);
  });
});
