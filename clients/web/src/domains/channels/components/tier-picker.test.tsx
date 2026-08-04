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
    '[data-slot="dropdown-trigger"]',
  );
  if (!trigger) {
    throw new Error("No dropdown trigger rendered");
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
  test("marks the default level and offers no separate Default entry", () => {
    renderPicker({ defaultTier: "low" });
    const options = openMenu();
    expect(options).toHaveLength(2);
    expect(optionLabeled(options, CONSERVATIVE).textContent).toContain(
      "default",
    );
    expect(
      options.some((el) => el.textContent?.startsWith("Default")),
    ).toBeFalse();
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
    fireEvent.click(optionLabeled(options, CONSERVATIVE));
    expect(onReset).toHaveBeenCalledTimes(1);
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

  test("re-selecting the current level pins rather than guessing a reset", () => {
    // The picker cannot know whether the unresolved default matches the
    // current level, and clearing the cell on a guess could silently change
    // effective access once the default resolves. Only the explicit Default
    // entry resets.
    const { onTierChange, onReset } = renderPicker({ tier: "low" });
    fireEvent.click(optionLabeled(openMenu(), CONSERVATIVE));
    expect(onTierChange).toHaveBeenCalledWith("low");
    expect(onReset).not.toHaveBeenCalled();
  });
});
