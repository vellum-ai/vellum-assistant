import { describe, expect, test } from "bun:test";

import {
  isDiagnosticsConsentVersionEligible,
  TRACE_COLLECTION_MIN_DIAGNOSTICS_CONSENT_VERSION,
} from "./trace-collection-policy.js";

describe("isDiagnosticsConsentVersionEligible", () => {
  test("the threshold version itself is eligible (>=, inclusive boundary)", () => {
    expect(
      isDiagnosticsConsentVersionEligible(
        TRACE_COLLECTION_MIN_DIAGNOSTICS_CONSENT_VERSION,
      ),
    ).toBe(true);
  });

  test("a later version is eligible", () => {
    expect(isDiagnosticsConsentVersionEligible("2999-01-01")).toBe(true);
  });

  test("an earlier version fails closed", () => {
    expect(isDiagnosticsConsentVersionEligible("2000-01-01")).toBe(false);
  });

  test("the empty version (never accepted / unversioned default) fails closed", () => {
    expect(isDiagnosticsConsentVersionEligible("")).toBe(false);
  });
});
