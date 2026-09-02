/**
 * Unit tests for the form-agnostic resolve callback.
 *
 * Every guardian form's outcome comes back through this one function, so what
 * it passes through and what it overrides is wire contract for all of them.
 */

import { describe, expect, test } from "bun:test";

import {
  type GuardianFormResult,
  openGuardianForm,
} from "../../guardian-form-registry.js";
import { resolveFormFromCallback } from "../guardian-form-routes.js";

/**
 * What a parked form settles as here. The rail passes a writer's own fields
 * through, so the base result alone would reject them as excess properties.
 */
type PassthroughResult = GuardianFormResult & Record<string, unknown>;

/** Park a form and hand back the id its broadcast carried. */
function park() {
  let requestId = "";
  const settled = openGuardianForm<PassthroughResult>({
    kind: "test.form",
    broadcast: {
      open: (id) => {
        requestId = id;
      },
      closed: () => {},
    },
  });
  return { requestId, settled };
}

describe("resolveFormFromCallback", () => {
  test("a failure keeps the fields sent alongside its error", async () => {
    const { requestId, settled } = park();

    expect(
      resolveFormFromCallback({
        body: { requestId, error: "Cancelled by user", cancelled: true },
      }),
    ).toEqual({ resolved: true });

    expect(await settled).toEqual({
      ok: false,
      error: "Cancelled by user",
      cancelled: true,
    });
  });

  test("a writer's own ok cannot turn its error into a success", async () => {
    const { requestId, settled } = park();

    resolveFormFromCallback({
      body: { requestId, ok: true, error: "The write failed" },
    });

    expect(await settled).toEqual({ ok: false, error: "The write failed" });
  });

  test("a result with no error still passes its fields through as a success", async () => {
    // The rail is only reusable if a new form's result reaches its caller. A
    // callback that enumerated contact fields would drop everything else.
    const { requestId, settled } = park();

    resolveFormFromCallback({
      body: { requestId, contactId: "ct_1", verified: true },
    });

    expect(await settled).toEqual({
      ok: true,
      contactId: "ct_1",
      verified: true,
    });
  });

  test("resolving a form nobody is waiting on reports that it landed nowhere", () => {
    expect(
      resolveFormFromCallback({ body: { requestId: "never-parked" } }),
    ).toEqual({ resolved: false });
  });
});
