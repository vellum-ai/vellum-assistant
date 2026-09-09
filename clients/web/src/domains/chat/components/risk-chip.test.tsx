/**
 * `RiskChip` has to agree with the shared `Tooltip` about whether a tooltip is
 * reachable, because the fallback text exists only for the case where it is
 * not. These pin that agreement to the hover-capability signal rather than to
 * any other device axis.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";

let hoverCapable = true;

const actualHoverAffordance = await import("@/hooks/use-hover-affordance");
mock.module("@/hooks/use-hover-affordance", () => ({
  ...actualHoverAffordance,
  useHoverCapable: () => hoverCapable,
}));

const { RiskChip } = await import("@/domains/chat/components/risk-chip");

const HINT = "Auto-approved at Conservative tolerance or higher";

afterEach(() => {
  cleanup();
  hoverCapable = true;
});

describe("RiskChip", () => {
  test("keeps the tolerance sentence as a tooltip where the device can hover", () => {
    const { getByTestId, queryByText } = render(<RiskChip level="low" />);

    expect(getByTestId("risk-badge").textContent).toBe("Low");
    expect(queryByText(HINT)).toBeNull();
  });

  test("renders the sentence as text where the device cannot hover", () => {
    // The shared `Tooltip` mounts nothing without hover, so a tooltip here
    // would be the only copy of the sentence and it would be unreachable.
    hoverCapable = false;
    const { getByTestId, getByText } = render(<RiskChip level="low" />);

    expect(getByTestId("risk-badge").textContent).toBe("Low");
    expect(getByText(HINT)).toBeDefined();
  });

  test("gives the tooltip trigger a tab stop so focus reaches it", () => {
    const { getByTestId } = render(<RiskChip level="low" />);

    expect(getByTestId("risk-badge").closest("[tabindex='0']")).not.toBeNull();
  });

  test("shows a bare pill for a level with no tolerance tier", () => {
    const { getByTestId, queryByText } = render(<RiskChip level="workspace" />);

    expect(getByTestId("risk-badge")).toBeDefined();
    expect(queryByText(HINT)).toBeNull();
  });

  test("renders nothing without a level", () => {
    const { container } = render(<RiskChip level={undefined} />);

    expect(container.textContent).toBe("");
  });
});
