/**
 * Request-body validation for the browser_tabs route.
 *
 * The handler validates with `parseBody` before touching the Chrome-extension
 * backend, so a malformed body is rejected with a `BadRequestError` (→ 400)
 * without any CDP wiring.
 */

import { describe, expect, test } from "bun:test";

import { ROUTES } from "../browser-tabs-routes.js";
import { BadRequestError } from "../errors.js";

const route = ROUTES[0];

describe("browser_tabs request body validation", () => {
  test("rejects a command outside the enum with BadRequestError", async () => {
    await expect(
      route.handler({
        body: { command: "frobnicate" } as Record<string, unknown>,
      }),
    ).rejects.toThrow(BadRequestError);
  });

  test("rejects a non-numeric tabId with BadRequestError", async () => {
    await expect(
      route.handler({
        body: { command: "select", tabId: "not-a-number" } as unknown as Record<
          string,
          unknown
        >,
      }),
    ).rejects.toThrow(BadRequestError);
  });
});
