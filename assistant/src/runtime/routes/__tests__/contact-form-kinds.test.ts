/**
 * Pins the contact form kinds the daemon opens its forms under.
 *
 * The gateway names these same strings when it claims a form, and a claim
 * naming a different kind is rejected. Nothing at compile time links the two
 * packages, so a rename on one side alone would show up only as contact forms
 * failing to submit. The gateway has the matching test; both must be edited
 * together for a rename to land.
 */
import { describe, expect, test } from "bun:test";

import {
  CONTACT_ADDRESS_FORM_KIND,
  CONTACT_RECORD_FORM_KIND,
} from "../contact-prompt-routes.js";

describe("contact form kinds", () => {
  test("match the strings the gateway claims under", () => {
    expect(CONTACT_ADDRESS_FORM_KIND).toBe("contacts.address");
    expect(CONTACT_RECORD_FORM_KIND).toBe("contacts.record");
  });
});
