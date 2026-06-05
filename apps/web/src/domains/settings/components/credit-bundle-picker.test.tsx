/**
 * Tests for the presentational `CreditBundlePicker`.
 *
 * Renders via `@testing-library/react` (happy-dom registered in test-setup.ts)
 * and drives the design-library Dropdown — a custom combobox, not a native
 * <select> — by clicking the trigger to open the listbox, then clicking the
 * option whose visible label matches. No jest-dom matchers; we assert with
 * plain bun `expect` against query results.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";

import type { CreditTier, CreditTierEnum } from "@/generated/api/types.gen";

import {
  CreditBundlePicker,
  formatBundleOptionLabel,
} from "./credit-bundle-picker";

afterEach(() => {
  cleanup();
});

const TIERS: CreditTier[] = [
  {
    tier: "credits_10",
    label: "10 credits",
    credits_usd: 10,
    price_cents: 1000,
    lookup_key: "credits_10",
  },
  {
    tier: "credits_25",
    label: "25 credits",
    credits_usd: 25,
    price_cents: 2500,
    lookup_key: "credits_25",
  },
  {
    tier: "credits_50",
    label: "50 credits",
    credits_usd: 50,
    price_cents: 5000,
    lookup_key: "credits_50",
  },
  {
    tier: "credits_100",
    label: "100 credits",
    credits_usd: 100,
    price_cents: 10000,
    lookup_key: "credits_100",
  },
  {
    tier: "credits_200",
    label: "200 credits",
    credits_usd: 200,
    price_cents: 20000,
    lookup_key: "credits_200",
  },
];

function openDropdown(): void {
  const trigger = document.querySelector<HTMLButtonElement>(
    'button[role="combobox"][aria-label="Credit bundle"]',
  );
  if (!trigger) {
    throw new Error("expected a Credit bundle dropdown trigger");
  }
  fireEvent.click(trigger);
}

function optionLabels(): string[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>('[role="option"]'),
  ).map((o) => o.textContent?.trim() ?? "");
}

function clickOption(label: string): void {
  const option = Array.from(
    document.querySelectorAll<HTMLElement>('[role="option"]'),
  ).find((o) => o.textContent?.trim() === label);
  if (!option) {
    throw new Error(
      `expected option "${label}" — saw: ${optionLabels()
        .map((l) => `"${l}"`)
        .join(", ")}`,
    );
  }
  fireEvent.click(option);
}

describe("formatBundleOptionLabel", () => {
  test("formats whole-dollar tiers", () => {
    expect(formatBundleOptionLabel(TIERS[2]!)).toBe("50 credits — $50/mo");
  });

  test("formats sub-dollar cents with two decimals", () => {
    expect(
      formatBundleOptionLabel({ ...TIERS[0]!, price_cents: 1050 }),
    ).toBe("10 credits — $10.50/mo");
  });
});

describe("CreditBundlePicker", () => {
  test("renders the no-bundle option first, then all five tiers with prices", () => {
    render(
      <CreditBundlePicker
        creditTiers={TIERS}
        selectedCreditTier={null}
        onCreditTierChange={() => {}}
      />,
    );
    openDropdown();

    expect(optionLabels()).toEqual([
      "No credit bundle — $0/mo",
      "10 credits — $10/mo",
      "25 credits — $25/mo",
      "50 credits — $50/mo",
      "100 credits — $100/mo",
      "200 credits — $200/mo",
    ]);
  });

  test("selecting a tier emits its CreditTierEnum value", () => {
    const onCreditTierChange = mock((_t: CreditTierEnum | null) => {});
    render(
      <CreditBundlePicker
        creditTiers={TIERS}
        selectedCreditTier={null}
        onCreditTierChange={onCreditTierChange}
      />,
    );
    openDropdown();
    clickOption("50 credits — $50/mo");

    expect(onCreditTierChange).toHaveBeenCalledTimes(1);
    expect(onCreditTierChange.mock.calls[0]?.[0]).toBe("credits_50");
  });

  test("selecting the no-bundle option emits null", () => {
    const onCreditTierChange = mock((_t: CreditTierEnum | null) => {});
    render(
      <CreditBundlePicker
        creditTiers={TIERS}
        selectedCreditTier="credits_50"
        onCreditTierChange={onCreditTierChange}
      />,
    );
    openDropdown();
    clickOption("No credit bundle — $0/mo");

    expect(onCreditTierChange).toHaveBeenCalledTimes(1);
    expect(onCreditTierChange.mock.calls[0]?.[0]).toBeNull();
  });
});
