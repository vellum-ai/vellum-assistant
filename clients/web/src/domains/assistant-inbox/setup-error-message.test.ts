import { describe, expect, test } from "bun:test";

import {
  readableSetupError,
  readDomainEmailError,
} from "./setup-error-message";

describe("readableSetupError", () => {
  test("swaps a relayed provider payload for its message", () => {
    expect(
      readableSetupError(
        'Failed to provision email domain: {"statusCode":403,"message":"You have reached the domain limit of your plan. Upgrade to add more.","name":"validation_error"}',
      ),
    ).toBe(
      "Failed to provision email domain: You have reached the domain limit of your plan. Upgrade to add more.",
    );
  });

  test("leaves a plain sentence, or a payload with no message, alone", () => {
    expect(readableSetupError("This email address is already taken.")).toBe(
      "This email address is already taken.",
    );
    expect(readableSetupError('Upstream said: {"statusCode":500}')).toBe(
      'Upstream said: {"statusCode":500}',
    );
    expect(readableSetupError("Odd: {not json}")).toBe("Odd: {not json}");
  });
});

describe("readDomainEmailError", () => {
  test("reads the partial-failure field off a domain response", () => {
    expect(
      readDomainEmailError({
        id: "d1",
        subdomain: "velly",
        email_error: {
          detail: "Failed to provision",
          code: "resend_domain_error",
        },
      }),
    ).toEqual({ detail: "Failed to provision", code: "resend_domain_error" });
  });

  test("is null when the address was registered", () => {
    expect(readDomainEmailError({ id: "d1", subdomain: "velly" })).toBeNull();
    expect(readDomainEmailError(null)).toBeNull();
    expect(readDomainEmailError({ email_error: "nope" })).toBeNull();
  });
});
