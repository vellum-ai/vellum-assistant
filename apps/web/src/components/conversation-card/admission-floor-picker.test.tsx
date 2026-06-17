import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, mock, test } from "bun:test";

import { AdmissionFloorPicker } from "./admission-floor-picker";

afterEach(() => cleanup());

describe("AdmissionFloorPicker", () => {
  test("shows the inherit option as the default selection when override is null", () => {
    render(
      <AdmissionFloorPicker
        override={null}
        typeFloor="trusted_contacts"
        channelLabel="Slack"
        onChange={() => {}}
      />,
    );

    // The trigger renders the selected option label; the inherit option
    // cites the type floor so the user knows what they're inheriting.
    expect(
      screen.getByText(/inherit channel default/i),
    ).toBeTruthy();
  });

  test("does NOT show a warning when the override matches the type floor", () => {
    render(
      <AdmissionFloorPicker
        override="trusted_contacts"
        typeFloor="trusted_contacts"
        channelLabel="Slack"
        onChange={() => {}}
      />,
    );

    expect(screen.queryByTestId("admission-floor-picker-warning")).toBeNull();
  });

  test("does NOT show a warning when the override is MORE restrictive than the type floor", () => {
    // §8.3: warning only fires when the override admits MORE senders.
    // Tightening below the type floor is silently allowed.
    render(
      <AdmissionFloorPicker
        override="guardian_only"
        typeFloor="trusted_contacts"
        channelLabel="Slack"
        onChange={() => {}}
      />,
    );

    expect(screen.queryByTestId("admission-floor-picker-warning")).toBeNull();
  });

  test("shows the divergence warning when the override is less restrictive than the type floor", () => {
    // §8.3: explicit warning copy citing both the type floor and the
    // chosen override so the user sees the trade-off.
    render(
      <AdmissionFloorPicker
        override="strangers"
        typeFloor="trusted_contacts"
        channelLabel="Slack"
        onChange={() => {}}
      />,
    );

    const warning = screen.getByTestId("admission-floor-picker-warning");
    expect(warning.textContent ?? "").toContain("Slack default is");
    expect(warning.textContent ?? "").toContain("admit more senders");
  });

  test("onChange returns null when the user selects the inherit option", () => {
    const onChange = mock(() => undefined);
    render(
      <AdmissionFloorPicker
        override="strangers"
        typeFloor="trusted_contacts"
        channelLabel="Slack"
        onChange={onChange}
      />,
    );

    // Open the menu then click the inherit row.
    fireEvent.click(screen.getByTestId("admission-floor-picker-dropdown"));
    fireEvent.click(screen.getByText(/inherit channel default/i));

    expect(onChange).toHaveBeenCalledWith(null);
  });
});
