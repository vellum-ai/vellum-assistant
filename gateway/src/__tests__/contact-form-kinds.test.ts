/**
 * Pins the contact form kinds the gateway claims under.
 *
 * The daemon opens its contact forms under these same strings and rejects a
 * claim naming a different one. Nothing at compile time links the two
 * packages, so a rename on one side alone would show up only as contact forms
 * failing to submit against a running daemon. The daemon has the matching
 * test; both must be edited together for a rename to land.
 */
import { describe, expect, test } from "bun:test";

import { ADDRESS_FORM, RECORD_FORM } from "../http/routes/contact-prompt.js";

describe("contact form kinds", () => {
  test("match the strings the daemon opens its forms under", () => {
    expect(ADDRESS_FORM).toBe("contacts.address");
    expect(RECORD_FORM).toBe("contacts.record");
  });
});
