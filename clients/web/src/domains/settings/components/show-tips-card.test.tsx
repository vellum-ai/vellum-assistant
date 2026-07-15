import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

import { useClientFeatureFlagStore } from "@/stores/client-feature-flag-store";
import { tipsEnabledStorage } from "@/utils/tips-storage";

import { ShowTipsCard } from "./show-tips-card";

function setProactiveTipsFlag(value: "off" | "on") {
  act(() => {
    useClientFeatureFlagStore
      .getState()
      .setStringFlags({ proactiveTips: value });
  });
}

beforeEach(() => {
  tipsEnabledStorage.remove();
  setProactiveTipsFlag("off");
});

afterEach(() => {
  cleanup();
});

describe("ShowTipsCard", () => {
  test("renders nothing when the proactive-tips flag is off", () => {
    render(<ShowTipsCard />);

    expect(screen.queryByRole("switch", { name: "Show tips" })).toBeNull();
  });

  test("renders on by default when the flag is on (storage fallback)", () => {
    setProactiveTipsFlag("on");
    render(<ShowTipsCard />);

    const toggle = screen.getByRole("switch", { name: "Show tips" });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
  });

  test("reflects a stored disabled value", () => {
    setProactiveTipsFlag("on");
    tipsEnabledStorage.save(false);
    render(<ShowTipsCard />);

    const toggle = screen.getByRole("switch", { name: "Show tips" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
  });

  test("clicking the toggle writes the new value to storage", () => {
    setProactiveTipsFlag("on");
    render(<ShowTipsCard />);

    const toggle = screen.getByRole("switch", { name: "Show tips" });
    fireEvent.click(toggle);

    expect(tipsEnabledStorage.load()).toBe(false);
    expect(toggle.getAttribute("aria-checked")).toBe("false");

    fireEvent.click(toggle);

    expect(tipsEnabledStorage.load()).toBe(true);
    expect(toggle.getAttribute("aria-checked")).toBe("true");
  });

  test("reacts to storage writes made outside the component", () => {
    setProactiveTipsFlag("on");
    render(<ShowTipsCard />);

    act(() => {
      tipsEnabledStorage.save(false);
    });

    const toggle = screen.getByRole("switch", { name: "Show tips" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
  });
});
