import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { isPreviewRequested, setPreviewRequested } from "@/lib/preview-channel";

let staff = true;

mock.module("@/lib/auth/staff", () => ({
  isVellumStaff: () => staff,
}));

mock.module("@/stores/auth-store", () => ({
  useAuthStore: { use: { user: () => ({ id: "user-1" }) } },
}));

const { PreviewUiChannel } = await import("./preview-ui-channel");

let reloads = 0;
window.location.reload = () => {
  reloads += 1;
};

beforeEach(() => {
  staff = true;
  reloads = 0;
  setPreviewRequested(false);
});

afterEach(() => {
  cleanup();
  setPreviewRequested(false);
});

describe("PreviewUiChannel", () => {
  test("opts a staff user in and reloads", () => {
    render(<PreviewUiChannel />);

    fireEvent.click(screen.getByRole("switch", { name: "Preview UI is off" }));

    expect(isPreviewRequested()).toBe(true);
    expect(reloads).toBe(1);
  });

  test("opts a staff user back out", () => {
    setPreviewRequested(true);
    render(<PreviewUiChannel />);

    fireEvent.click(screen.getByRole("switch", { name: "Preview UI is on" }));

    expect(isPreviewRequested()).toBe(false);
    expect(reloads).toBe(1);
  });

  test("reports the running build and how to reset a stuck request", () => {
    setPreviewRequested(true);
    render(<PreviewUiChannel />);

    expect(screen.getByText("Running: stable build unknown")).toBeDefined();
    expect(
      screen.getByText(
        "No preview build is being served, so this browser is still on stable. Delete the vellum_preview cookie in devtools to reset.",
      ),
    ).toBeDefined();
  });

  test("renders nothing for non-staff users", () => {
    staff = false;
    const { container } = render(<PreviewUiChannel />);

    expect(container.innerHTML).toBe("");
  });
});
