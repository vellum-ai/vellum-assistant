/**
 * Tests for `UpdateAvailableBadge`.
 *
 * The badge renders the "Update available" label inside the design-library
 * `Tag` primitive (which exposes `data-slot="tag"`) rather than a bare span,
 * so the affordance matches the Skills tab styling.
 *
 * Mounted via `@testing-library/react` (happy-dom — see
 * `clients/web/test-setup.ts`).
 */

import { afterEach, describe, expect, test } from "bun:test";

import { cleanup, render } from "@testing-library/react";

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
});
