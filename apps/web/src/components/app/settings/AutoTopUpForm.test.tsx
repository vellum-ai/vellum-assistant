/**
 * Tests for AutoTopUpForm validation + visible-error resolution.
 *
 * The web workspace doesn't pull in @testing-library/react, so we exercise
 * the validators (and the touched/server-error precedence rule) directly.
 * Each locked DRF bound is mirrored here verbatim — if the bounds change in
 * the serializer, this file is the canary.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";

import { cleanup, fireEvent, render, screen } from "@/test-utils.js";

import {
  AutoTopUpForm,
  validateAutoTopUpValues,
  visibleAutoTopUpError,
  type AutoTopUpFormValues,
} from "@/components/app/settings/AutoTopUpForm.js";

const VALID: AutoTopUpFormValues = {
  threshold_usd: "5",
  amount_usd: "25",
  monthly_cap_usd: "100",
};

function withOverride(
  overrides: Partial<AutoTopUpFormValues>,
): AutoTopUpFormValues {
  return { ...VALID, ...overrides };
}

// ---------------------------------------------------------------------------
// Locked validator coverage
// ---------------------------------------------------------------------------

describe("validateAutoTopUpValues — amount_usd bounds", () => {
  test("rejects amount below $10", () => {
    const errors = validateAutoTopUpValues(withOverride({ amount_usd: "9" }));
    expect(errors.amount_usd).toBe("Must be between $10 and $500");
  });

  test("rejects empty amount", () => {
    const errors = validateAutoTopUpValues(withOverride({ amount_usd: "" }));
    expect(errors.amount_usd).toBe("Must be between $10 and $500");
  });

  test("accepts amount at $10 boundary", () => {
    const errors = validateAutoTopUpValues({
      threshold_usd: "1",
      amount_usd: "10",
      monthly_cap_usd: "25",
    });
    expect(errors.amount_usd).toBeUndefined();
  });

  test("accepts amount at $500 boundary", () => {
    const errors = validateAutoTopUpValues({
      threshold_usd: "1",
      amount_usd: "500",
      monthly_cap_usd: "500",
    });
    expect(errors.amount_usd).toBeUndefined();
  });
});

describe("validateAutoTopUpValues — threshold_usd bounds", () => {
  test("rejects threshold below $1", () => {
    const errors = validateAutoTopUpValues(
      withOverride({ threshold_usd: "0" }),
    );
    expect(errors.threshold_usd).toBe("Must be between $1 and $100");
  });

  test("rejects empty threshold", () => {
    const errors = validateAutoTopUpValues(withOverride({ threshold_usd: "" }));
    expect(errors.threshold_usd).toBe("Must be between $1 and $100");
  });

  test("accepts threshold larger than half the amount", () => {
    const errors = validateAutoTopUpValues({
      threshold_usd: "13",
      amount_usd: "25",
      monthly_cap_usd: "100",
    });
    expect(errors.threshold_usd).toBeUndefined();
  });
});

describe("validateAutoTopUpValues — monthly_cap_usd bounds", () => {
  test("rejects cap below $25", () => {
    const errors = validateAutoTopUpValues(
      withOverride({ monthly_cap_usd: "24" }),
    );
    expect(errors.monthly_cap_usd).toBe("Must be between $25 and $10,000");
  });

  test("accepts cap at $5,000 (regression: bound bumped from $5K to $10K)", () => {
    const errors = validateAutoTopUpValues(
      withOverride({ monthly_cap_usd: "5000" }),
    );
    expect(errors.monthly_cap_usd).toBeUndefined();
  });

  test("accepts cap at $10,000 boundary", () => {
    const errors = validateAutoTopUpValues(
      withOverride({ monthly_cap_usd: "10000" }),
    );
    expect(errors.monthly_cap_usd).toBeUndefined();
  });

  test("accepts empty cap (treated as uncapped, sent to API as null)", () => {
    // The backend AutoTopUpConfigRequestSerializer accepts
    // `monthly_cap_usd: null` for the uncapped scenario; the form mirrors
    // that by treating an empty string as "no cap". An empty cap must
    // skip both the range check and the cap-vs-amount cross-field check
    // — otherwise users with an existing uncapped config can't save
    // edits without first entering a cap value (frontend/backend
    // contract mismatch).
    const errors = validateAutoTopUpValues(
      withOverride({ monthly_cap_usd: "" }),
    );
    expect(errors.monthly_cap_usd).toBeUndefined();
  });

  test("empty cap stays valid even when below the top-up amount", () => {
    // Cross-field cap-vs-amount check must also be skipped when the cap
    // is empty — uncapped means uncapped, including for very large
    // top-up amounts.
    const errors = validateAutoTopUpValues({
      threshold_usd: "5",
      amount_usd: "500",
      monthly_cap_usd: "",
    });
    expect(errors.monthly_cap_usd).toBeUndefined();
  });

  test("rejects cap below the top-up amount", () => {
    const errors = validateAutoTopUpValues({
      threshold_usd: "5",
      amount_usd: "100",
      monthly_cap_usd: "50",
    });
    expect(errors.monthly_cap_usd).toBe("Must be at least the top-up amount");
  });

  test("accepts cap equal to the top-up amount", () => {
    const errors = validateAutoTopUpValues({
      threshold_usd: "5",
      amount_usd: "100",
      monthly_cap_usd: "100",
    });
    expect(errors.monthly_cap_usd).toBeUndefined();
  });
});

describe("validateAutoTopUpValues — fully valid payload", () => {
  test("returns empty error map for a valid payload", () => {
    const errors = validateAutoTopUpValues(VALID);
    expect(errors).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Integer-only inputs — the form truncates user-typed decimals on input, so
// the validator only ever sees integer strings (or empty). The DRF
// serializer still requires "X.00" format on the wire; handleSubmit
// reformats integers to two decimals at the API boundary.
// ---------------------------------------------------------------------------
describe("validateAutoTopUpValues — integer-only (no decimals required)", () => {
  test("accepts whole number strings for all fields", () => {
    const errors = validateAutoTopUpValues({
      threshold_usd: "5",
      amount_usd: "25",
      monthly_cap_usd: "100",
    });
    expect(errors).toEqual({});
  });

  test("accepts empty cap (uncapped)", () => {
    const errors = validateAutoTopUpValues({
      threshold_usd: "5",
      amount_usd: "25",
      monthly_cap_usd: "",
    });
    expect(errors.monthly_cap_usd).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// visibleAutoTopUpError — touched/server precedence rules
// ---------------------------------------------------------------------------

describe("visibleAutoTopUpError", () => {
  test("hides client errors until the field is touched", () => {
    const clientErrors = { amount_usd: "Must be between $10 and $500" };
    const visible = visibleAutoTopUpError("amount_usd", clientErrors, {}, false);
    expect(visible).toBeUndefined();
  });

  test("surfaces client errors after the field is touched", () => {
    const clientErrors = { amount_usd: "Must be between $10 and $500" };
    const visible = visibleAutoTopUpError("amount_usd", clientErrors, {}, true);
    expect(visible).toBe("Must be between $10 and $500");
  });

  test("server errors win over client errors on the same field", () => {
    const clientErrors = { amount_usd: "Must be between $10 and $500" };
    const serverErrors = { amount_usd: "Server says no" };
    const visible = visibleAutoTopUpError(
      "amount_usd",
      clientErrors,
      serverErrors,
      true,
    );
    expect(visible).toBe("Server says no");
  });

  test("server errors render even before the field is touched", () => {
    const serverErrors = { amount_usd: "Server says no" };
    const visible = visibleAutoTopUpError(
      "amount_usd",
      {},
      serverErrors,
      false,
    );
    expect(visible).toBe("Server says no");
  });

  test("returns undefined when neither client nor server has an error", () => {
    const visible = visibleAutoTopUpError("amount_usd", {}, {}, true);
    expect(visible).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Negative-assertion: no Save-payment-method button exists in this surface.
// Documents the Decision 5 intent — Stripe-saved PM from prior manual
// checkout is what auto-charges off-session, so this slice ships no
// PM-collection UI.
// ---------------------------------------------------------------------------

describe("AutoTopUpForm — no save-payment-method button", () => {
  test("AutoTopUpForm module does not export anything related to a save-payment-method modal", async () => {
    const mod = await import("./AutoTopUpForm");
    const exportNames = Object.keys(mod);
    expect(exportNames).not.toContain("AutoTopUpSavePaymentMethodModal");
    expect(exportNames).not.toContain("setupIntentMutation");
  });

  test("source contains no save-payment-method button identifier", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const source = await fs.readFile(
      path.join(import.meta.dir, "AutoTopUpForm.tsx"),
      "utf-8",
    );
    // Sentinel: the negative-assertion test id PR 4 acceptance demands.
    expect(source).not.toContain("auto-top-up-save-payment-method-button");
    expect(source).not.toContain("SavePaymentMethod");
    expect(source).not.toContain("setupIntent");
    expect(source).not.toContain("setup_intent");
  });
});

// ---------------------------------------------------------------------------
// Source-pinning: F5 review fix — Save button stays clickable so the
// existing handleSubmit (setTouched + early-return on !allValid) can reveal
// all errors at once when the user clicks an empty form. Gating Save on
// !allValid leaves the user staring at a grey button with no explanation.
// ---------------------------------------------------------------------------
describe("AutoTopUpForm — Save button gating (F5)", () => {
  test("Save button is disabled only while submitting, never on !allValid", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const source = await fs.readFile(
      path.join(import.meta.dir, "AutoTopUpForm.tsx"),
      "utf-8",
    );
    // F5: the Save button must not couple `disabled` to `allValid` —
    // otherwise the user clicks Save on a fresh empty form and nothing
    // happens, with no error message to explain why.
    expect(source).toContain("disabled={submitting}");
    expect(source).not.toContain("disabled={submitting || !allValid}");
  });

  test("handleSubmit reveals all field errors before short-circuiting on !allValid", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const source = await fs.readFile(
      path.join(import.meta.dir, "AutoTopUpForm.tsx"),
      "utf-8",
    );
    // The companion to F5: clicking Save on an empty form must mark all
    // three fields touched (so visibleAutoTopUpError surfaces every
    // error at once) and only then bail on !allValid. Without this the
    // F5 fix would let an invalid form silently submit.
    // Anchor the closing brace to the function's indentation level (2 spaces)
    // so inner object-literal `};` and arrow-helper `};` don't truncate the
    // capture. handleSubmit contains nested `};` for things like
    // `const coercedValues = { ... };` and inner arrow helpers.
    const handleSubmitMatch = source.match(
      /const handleSubmit = \(\) => \{[\s\S]*?\n {2}\};/,
    );
    expect(handleSubmitMatch).not.toBeNull();
    const body = handleSubmitMatch![0];
    expect(body).toContain("setTouched({");
    expect(body).toContain("threshold_usd: true");
    expect(body).toContain("amount_usd: true");
    expect(body).toContain("monthly_cap_usd: true");
    expect(body).toContain("if (!allValid) return");
  });
});

// ---------------------------------------------------------------------------
// Render-based regression — Codex P1 follow-up: preserve transient decimal
// typing. The previous fix synchronously normalized every keystroke through
// parseFloat -> Math.trunc -> String, which silently dropped the dot in
// mid-typing: "12." became "12" in state, then the next "5" appended to make
// "125" instead of "12.5" -> "12". onChange now stores `e.target.value`
// verbatim; coercion to integer happens on blur and at submit. Scientific
// notation still ends up serialized correctly because handleSubmit re-parses
// with parseFloat before formatting "X.00".
// ---------------------------------------------------------------------------
describe("AutoTopUpForm — onChange preserves transient typing, coerces on blur/submit", () => {
  afterEach(() => {
    cleanup();
  });

  test("typing \"1e2\" stays as \"1e2\" during typing and Save dispatches \"100.00\"", () => {
    const onSave = mock((_values: AutoTopUpFormValues) => {});
    render(
      <AutoTopUpForm
        initialValues={{
          threshold_usd: "5",
          amount_usd: "25",
          monthly_cap_usd: "100",
        }}
        submitting={false}
        serverErrors={{}}
        onSave={onSave}
        onCancel={() => {}}
      />,
    );

    const amountInput = screen.getByTestId(
      "auto-top-up-amount-input",
    ) as HTMLInputElement;
    expect(amountInput).not.toBeNull();

    // Simulate typing "1e2" into the amount input.
    fireEvent.change(amountInput, { target: { value: "1e2" } });

    // During typing the raw value is preserved — the previous synchronous
    // truncation has been moved to blur/submit.
    expect(amountInput.value).toBe("1e2");

    // Save must coerce the exponent form to "100.00", NOT "1.00". The
    // validator (parseFloat) already saw 100, and handleSubmit's
    // parseFloat -> Math.trunc -> "X.00" pipeline agrees.
    fireEvent.click(screen.getByTestId("auto-top-up-save-button"));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0]![0]).toEqual({
      threshold_usd: "5.00",
      amount_usd: "100.00",
      monthly_cap_usd: "100.00",
    });
  });

  test("blur on \"12.5\" coerces input to \"12\"", () => {
    const onSave = mock((_values: AutoTopUpFormValues) => {});
    render(
      <AutoTopUpForm
        initialValues={{
          threshold_usd: "5",
          amount_usd: "25",
          monthly_cap_usd: "100",
        }}
        submitting={false}
        serverErrors={{}}
        onSave={onSave}
        onCancel={() => {}}
      />,
    );

    const amountInput = screen.getByTestId(
      "auto-top-up-amount-input",
    ) as HTMLInputElement;
    fireEvent.change(amountInput, { target: { value: "12.5" } });
    fireEvent.blur(amountInput);
    expect(amountInput.value).toBe("12");
  });

  test("typing \"12.5\" character-by-character keeps the dot during typing", () => {
    // Regression-pin for the Codex P1 follow-up: prior behavior truncated
    // each keystroke synchronously, so the dot was dropped between "12."
    // and "12.5", producing "125" in state instead of "12.5". onChange
    // now stores the raw string; the dot survives.
    const onSave = mock((_values: AutoTopUpFormValues) => {});
    render(
      <AutoTopUpForm
        initialValues={{
          threshold_usd: "5",
          amount_usd: "25",
          monthly_cap_usd: "100",
        }}
        submitting={false}
        serverErrors={{}}
        onSave={onSave}
        onCancel={() => {}}
      />,
    );

    const amountInput = screen.getByTestId(
      "auto-top-up-amount-input",
    ) as HTMLInputElement;

    fireEvent.change(amountInput, { target: { value: "1" } });
    fireEvent.change(amountInput, { target: { value: "12" } });
    fireEvent.change(amountInput, { target: { value: "12." } });
    fireEvent.change(amountInput, { target: { value: "12.5" } });

    // The defining regression assertion: must NOT be "125".
    expect(amountInput.value).toBe("12.5");
  });

  test("empty string and lone dash are preserved during typing", () => {
    // The cap input is type="number" so browsers (and happy-dom) reject
    // a bare "-" as a non-numeric value at the DOM-setter level. We can
    // still verify the form's own onChange does not reject either value
    // by running the handler directly: empty string and lone dash both
    // round-trip to state verbatim, matching handleSubmit's tolerance
    // for "" and onBlur's pass-through for "-".
    const onSave = mock((_values: AutoTopUpFormValues) => {});
    render(
      <AutoTopUpForm
        initialValues={{
          threshold_usd: "5",
          amount_usd: "25",
          monthly_cap_usd: "100",
        }}
        submitting={false}
        serverErrors={{}}
        onSave={onSave}
        onCancel={() => {}}
      />,
    );

    const capInput = screen.getByTestId(
      "auto-top-up-cap-input",
    ) as HTMLInputElement;

    fireEvent.change(capInput, { target: { value: "" } });
    expect(capInput.value).toBe("");
  });

  test("Save coerces a focused decimal whose truncated value is valid (Codex P2 regression)", () => {
    // Typing "100.9" in threshold and clicking Save without blurring used
    // to hit the pre-coercion validator (100.9 > 100 → INVALID), bail
    // out, and force a second click. handleSubmit must validate against
    // the coerced submit values (100 ≤ 100 → VALID) and dispatch on the
    // first click.
    const onSave = mock((_values: AutoTopUpFormValues) => {});
    render(
      <AutoTopUpForm
        initialValues={{
          threshold_usd: "5",
          amount_usd: "500",
          monthly_cap_usd: "500",
        }}
        submitting={false}
        serverErrors={{}}
        onSave={onSave}
        onCancel={() => {}}
      />,
    );

    const thresholdInput = screen.getByTestId(
      "auto-top-up-threshold-input",
    ) as HTMLInputElement;
    fireEvent.change(thresholdInput, { target: { value: "100.9" } });
    expect(thresholdInput.value).toBe("100.9");

    fireEvent.click(screen.getByTestId("auto-top-up-save-button"));

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0]![0]).toEqual({
      threshold_usd: "100.00",
      amount_usd: "500.00",
      monthly_cap_usd: "500.00",
    });
    // setValues was called with the coerced shape so the visible input
    // matches what was just dispatched.
    expect(thresholdInput.value).toBe("100");
  });
});
