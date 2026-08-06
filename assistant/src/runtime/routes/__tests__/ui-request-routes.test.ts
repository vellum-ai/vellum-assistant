/**
 * Request-body validation for the ui_request route.
 *
 * The handler validates with `parseBody`, so a malformed body is rejected with
 * a `BadRequestError` (→ 400) instead of the raw `ZodError` a bare `.parse()`
 * surfaces — which neither adapter maps, so it becomes a 500 — before any
 * interactive UI surface is requested.
 *
 * The handler is `async`, so the rejection surfaces as a rejected promise.
 */

import { describe, expect, test } from "bun:test";

import { BadRequestError } from "../errors.js";
import { ROUTES } from "../ui-request-routes.js";

const route = ROUTES[0];

describe("ui_request body validation", () => {
  test("rejects a body missing required fields with BadRequestError", async () => {
    await expect(
      route.handler({ body: {} as Record<string, unknown> }),
    ).rejects.toThrow(BadRequestError);
  });

  test("rejects an out-of-enum surfaceType with BadRequestError", async () => {
    await expect(
      route.handler({
        body: {
          conversationId: "c1",
          surfaceType: "bogus",
          data: {},
        } as unknown as Record<string, unknown>,
      }),
    ).rejects.toThrow(BadRequestError);
  });
});
