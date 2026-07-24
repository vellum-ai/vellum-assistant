/**
 * Request-body validation for the Vercel integration config route.
 *
 * `handlePostVercelConfig` validates with `parseBody` before it dispatches on
 * `action` or touches the credential store, so a malformed body is rejected
 * with a `BadRequestError` (→ 400) without any side effects. Both fields are
 * optional, so validation only trips on a wrong type / out-of-enum value.
 *
 * The handler is `async`, so `parseBody` throwing surfaces as a rejected
 * promise — hence the `.rejects` form.
 */

import { describe, expect, test } from "bun:test";

import { BadRequestError } from "../../errors.js";
import { ROUTES } from "../vercel.js";

const routeFor = (operationId: string) => {
  const route = ROUTES.find((r) => r.operationId === operationId);
  if (!route) {
    throw new Error(`no route: ${operationId}`);
  }
  return route;
};

describe("integrations_vercel_config_post body validation", () => {
  test("rejects an action outside the enum with BadRequestError", async () => {
    await expect(
      routeFor("integrations_vercel_config_post").handler({
        body: { action: "frobnicate" } as unknown as Record<string, unknown>,
      }),
    ).rejects.toThrow(BadRequestError);
  });

  test("rejects a non-string apiToken with BadRequestError", async () => {
    await expect(
      routeFor("integrations_vercel_config_post").handler({
        body: { action: "set", apiToken: 123 } as unknown as Record<
          string,
          unknown
        >,
      }),
    ).rejects.toThrow(BadRequestError);
  });
});
