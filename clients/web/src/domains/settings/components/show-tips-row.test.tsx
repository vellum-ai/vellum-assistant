import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const emitTipEvent = mock(() => {});
mock.module("@/utils/tips-telemetry", () => ({ emitTipEvent }));

const { useClientFeatureFlagStore } = await import(
  "@/stores/client-feature-flag-store"
);
const { tipsEnabledStorage } = await import("@/utils/tips-storage");
const { ShowTipsRow } = await import("./show-tips-row");

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
  emitTipEvent.mockClear();
});

afterEach(() => {
  cleanup();
});

describe("ShowTipsRow", () => {
  test("renders nothing when the proactive-tips flag is off", () => {
    render(<ShowTipsRow />);

    expect(screen.queryByRole("switch", { name: "Show tips" })).toBeNull();
  });

  test("renders on by default when the flag is on (storage fallback)", () => {
    setProactiveTipsFlag("on");
    render(<ShowTipsRow />);

    const toggle = screen.getByRole("switch", { name: "Show tips" });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
  });

  test("reflects a stored disabled value", () => {
    setProactiveTipsFlag("on");
    tipsEnabledStorage.save(false);
    render(<ShowTipsRow />);

    const toggle = screen.getByRole("switch", { name: "Show tips" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
  });

  test("clicking the toggle writes the new value to storage", () => {
    setProactiveTipsFlag("on");
    render(<ShowTipsRow />);

    const toggle = screen.getByRole("switch", { name: "Show tips" });
    fireEvent.click(toggle);

    expect(tipsEnabledStorage.load()).toBe(false);
    expect(toggle.getAttribute("aria-checked")).toBe("false");

    fireEvent.click(toggle);

    expect(tipsEnabledStorage.load()).toBe(true);
    expect(toggle.getAttribute("aria-checked")).toBe("true");
  });

  test("turning tips off emits the opt-out event; turning back on does not", () => {
    setProactiveTipsFlag("on");
    render(<ShowTipsRow />);

    const toggle = screen.getByRole("switch", { name: "Show tips" });
    fireEvent.click(toggle);

    expect(emitTipEvent).toHaveBeenCalledTimes(1);
    expect(emitTipEvent).toHaveBeenCalledWith(
      "settings",
      "dont_show_again",
      "on",
    );

    fireEvent.click(toggle);

    expect(emitTipEvent).toHaveBeenCalledTimes(1);
  });

  test("reacts to storage writes made outside the component", () => {
    setProactiveTipsFlag("on");
    render(<ShowTipsRow />);

    act(() => {
      tipsEnabledStorage.save(false);
    });

    const toggle = screen.getByRole("switch", { name: "Show tips" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
  });
});
