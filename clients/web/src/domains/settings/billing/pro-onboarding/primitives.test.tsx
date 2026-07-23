/**
 * Tests for the pure-presentational card-chrome primitives. Renders via
 * `@testing-library/react` (happy-dom registered in test-setup.ts). The lazy
 * avatar-components hook and the SVG-compositing renderer are mocked so the
 * tests exercise placement/gating logic, not the bundled avatar payload.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";

let avatarComponents: unknown = { colors: [] };
mock.module("@/utils/use-bundled-avatar-components", () => ({
  preloadBundledAvatarComponents: () => {},
  useBundledAvatarComponents: () => avatarComponents,
}));
mock.module("@/components/avatar-renderer", () => ({
  AvatarRenderer: () => <span data-testid="creature-avatar" />,
}));

const { CreatureCorners, WizardCardHeading } = await import("./primitives");

afterEach(() => {
  cleanup();
  avatarComponents = { colors: [] };
});

describe("WizardCardHeading", () => {
  test("renders the title", () => {
    const { getByText } = render(<WizardCardHeading title="Confirm your email" />);
    expect(getByText("Confirm your email")).toBeTruthy();
  });

  test("renders the subtitle when provided", () => {
    const { getByText } = render(
      <WizardCardHeading title="Confirm your email" subtitle="We'll send a code" />,
    );
    expect(getByText("Confirm your email")).toBeTruthy();
    expect(getByText("We'll send a code")).toBeTruthy();
  });

  test("omits the subtitle paragraph when not provided", () => {
    const { container } = render(<WizardCardHeading title="Just a title" />);
    expect(container.querySelector("p")).toBeNull();
  });
});

describe("CreatureCorners", () => {
  test("renders three creatures for the top variant", () => {
    const { getAllByTestId } = render(<CreatureCorners variant="top" />);
    expect(getAllByTestId("creature-avatar")).toHaveLength(3);
  });

  test("renders six creatures for the full variant (default)", () => {
    const { getAllByTestId } = render(<CreatureCorners />);
    expect(getAllByTestId("creature-avatar")).toHaveLength(6);
  });

  test("the decoration layer is aria-hidden", () => {
    const { getByTestId } = render(<CreatureCorners variant="full" />);
    expect(getByTestId("creature-corners").getAttribute("aria-hidden")).toBe(
      "true",
    );
  });

  test("renders nothing until the avatar components resolve", () => {
    avatarComponents = null;
    const { queryByTestId } = render(<CreatureCorners variant="full" />);
    expect(queryByTestId("creature-corners")).toBeNull();
    expect(queryByTestId("creature-avatar")).toBeNull();
  });
});
