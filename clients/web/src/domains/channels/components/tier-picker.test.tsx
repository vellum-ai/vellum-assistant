import { afterEach, describe, expect, mock, test } from "bun:test";

import { cleanup, fireEvent, render } from "@testing-library/react";

import {
  TierPicker,
  type TierPickerProps,
} from "@/domains/channels/components/tier-picker";

// CHANNEL_TIER_VALUES preset labels: "none" is Strict, "low" is Conservative.
const STRICT = "Strict";
const CONSERVATIVE = "Conservative";

function renderPicker(props: Partial<TierPickerProps> = {}) {
  const onTierChange = mock((_tier: string) => {});
  const onReset = mock(() => {});
  render(
    <TierPicker
      tier={undefined}
      defaultTier={null}
      onTierChange={onTierChange}
      onReset={onReset}
      aria-label="Assistant Access in #general"
      {...props}
    />,
  );
  return { onTierChange, onReset };
}

function openMenu(): HTMLElement[] {
  const trigger = document.querySelector<HTMLElement>(
    '[data-slot="select-trigger"]',
  );
  if (!trigger) {
    throw new Error("No select trigger rendered");
  }
  fireEvent.click(trigger);
  return Array.from(document.querySelectorAll<HTMLElement>('[role="option"]'));
}

function optionLabeled(options: HTMLElement[], label: string): HTMLElement {
  const match = options.find((el) => el.textContent?.startsWith(label));
  if (!match) {
    const seen = options.map((el) => el.textContent).join(", ");
    throw new Error(`No option labeled "${label}" (saw: ${seen})`);
  }
  return match;
}

afterEach(() => {
  cleanup();
});

describe("TierPicker with a resolved default", () => {
  test("marks the default level and still offers a Default entry", () => {
    renderPicker({ defaultTier: "low" });
    const options = openMenu();
    expect(options).toHaveLength(3);
    expect(optionLabeled(options, CONSERVATIVE).textContent).toContain(
      "default",
    );
    // Offered even with the default resolved. Radix reports no selection
    // when the chosen value already matches the shown one, so this row is
    // the only way to clear a cell pinned to the default's own level.
    expect(
      options.some((el) => el.textContent?.startsWith("Default")),
    ).toBeTrue();
  });

  test("a cell pinned to the default's own level can still be cleared", () => {
    // The state with no way out otherwise: the trigger shows Conservative
    // either way, so re-picking it reports nothing.
    const { onTierChange, onReset } = renderPicker({
      tier: "low",
      defaultTier: "low",
    });
    fireEvent.click(optionLabeled(openMenu(), "Default"));
    expect(onReset).toHaveBeenCalledTimes(1);
    expect(onTierChange).not.toHaveBeenCalled();
  });

  test("selecting the default-marked level resets instead of pinning", () => {
    const { onTierChange, onReset } = renderPicker({
      tier: "none",
      defaultTier: "low",
    });
    fireEvent.click(optionLabeled(openMenu(), CONSERVATIVE));
    expect(onReset).toHaveBeenCalledTimes(1);
    expect(onTierChange).not.toHaveBeenCalled();
  });

  test("selecting a non-default level pins it", () => {
    const { onTierChange, onReset } = renderPicker({ defaultTier: "low" });
    fireEvent.click(optionLabeled(openMenu(), STRICT));
    expect(onTierChange).toHaveBeenCalledWith("none");
    expect(onReset).not.toHaveBeenCalled();
  });

  test("a medium default collapses to the level it behaves as", () => {
    const { onTierChange, onReset } = renderPicker({ defaultTier: "medium" });
    const options = openMenu();
    expect(optionLabeled(options, CONSERVATIVE).textContent).toContain(
      "default",
    );

    // A selection matching the displayed level is not reported, so neither
    // callback runs. Nothing is lost here: the cell is already absent, so a
    // reset would clear nothing. "Default" covers the case where a cell does
    // exist.
    fireEvent.click(optionLabeled(options, CONSERVATIVE));
    expect(onReset).not.toHaveBeenCalled();
    expect(onTierChange).not.toHaveBeenCalled();
  });
});

describe("TierPicker with an unresolved default (defaultTier null)", () => {
  test("carries an explicit Default entry and marks no level", () => {
    renderPicker({ tier: "low" });
    const options = openMenu();
    expect(options).toHaveLength(3);
    expect(options[0]?.textContent).toStartWith("Default");
    expect(
      options.some((el) => el.textContent?.includes("default")),
    ).toBeFalse();
  });

  test("selecting Default resets an explicit override", () => {
    const { onTierChange, onReset } = renderPicker({ tier: "low" });
    fireEvent.click(optionLabeled(openMenu(), "Default"));
    expect(onReset).toHaveBeenCalledTimes(1);
    expect(onTierChange).not.toHaveBeenCalled();
  });

  test("selecting Default on a cell-less scope still resets, never writes", () => {
    const { onTierChange, onReset } = renderPicker();
    fireEvent.click(optionLabeled(openMenu(), "Default"));
    expect(onReset).toHaveBeenCalledTimes(1);
    expect(onTierChange).not.toHaveBeenCalled();
  });

  test("selecting a level pins it", () => {
    const { onTierChange, onReset } = renderPicker({ tier: "low" });
    fireEvent.click(optionLabeled(openMenu(), STRICT));
    expect(onTierChange).toHaveBeenCalledWith("none");
    expect(onReset).not.toHaveBeenCalled();
  });

  test("re-selecting the current level writes nothing", () => {
    // A selection matching the displayed level is not reported, so neither
    // callback runs. Re-pinning the same value would change nothing anyway.
    // Clearing goes through the "Default" entry, which is the only choice
    // that means "follow the default" without guessing at whether the
    // unresolved default matches this level.
    const { onTierChange, onReset } = renderPicker({ tier: "low" });
    fireEvent.click(optionLabeled(openMenu(), CONSERVATIVE));
    expect(onTierChange).not.toHaveBeenCalled();
    expect(onReset).not.toHaveBeenCalled();
  });
});
