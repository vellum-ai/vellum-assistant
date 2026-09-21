/**
 * Tests for `UpdateAvailableBadge`.
 *
 * The badge renders the "Update available" label inside the design-library
 * `Tag` primitive (which exposes `data-slot="tag"`) rather than a bare span,
 * so the affordance matches the Skills tab styling. With `onClick` it is the
 * library's `Chip`, the same pill as a real button, rather than a `Tag`
 * wrapped in a bare `<button>`.
 *
 * Mounted via `@testing-library/react` (happy-dom — see
 * `clients/web/test-setup.ts`).
 */

import { afterEach, describe, expect, mock, test } from "bun:test";

import { cleanup, fireEvent, render } from "@testing-library/react";

import { UpdateAvailableBadge } from "@/domains/intelligence/components/plugins/update-available-badge.js";

afterEach(() => {
  cleanup();
});

describe("UpdateAvailableBadge", () => {
  test("renders the 'Update available' label inside a Tag", () => {
    const { getByText } = render(<UpdateAvailableBadge />);

    const label = getByText("Update available");
    const tag = label.closest('[data-slot="tag"]');

    expect(tag).not.toBeNull();
    expect(tag?.tagName.toLowerCase()).toBe("span");
  });

  test("with onClick, renders a single Chip button that upgrades without selecting the row", () => {
    const onClick = mock(() => {});
    const onRowClick = mock(() => {});
    const { getByRole, container } = render(
      <div onClick={onRowClick}>
        <UpdateAvailableBadge onClick={onClick} />
      </div>,
    );

    const button = getByRole("button", { name: "Upgrade plugin" });
    expect(button.getAttribute("data-slot")).toBe("chip");
    expect(button.getAttribute("type")).toBe("button");
    expect(button.hasAttribute("aria-pressed")).toBe(false);
    expect(button.textContent).toBe("Update available");
    expect(container.querySelector('[data-slot="tag"]')).toBeNull();

    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onRowClick).not.toHaveBeenCalled();
  });

  test("while upgrading, the Chip is disabled", () => {
    const { getByRole } = render(
      <UpdateAvailableBadge onClick={() => {}} isUpgrading />,
    );
    expect(
      (getByRole("button", { name: "Upgrade plugin" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });
});
