/**
 * Tests for `PluginOriginBadge`. Asserts the label + leading lucide icon
 * switch on the `external` prop. Mounted via `@testing-library/react`
 * (happy-dom — see `clients/web/test-setup.ts`).
 */

import { afterEach, describe, expect, test } from "bun:test";

import { cleanup, render } from "@testing-library/react";

import { PluginOriginBadge } from "@/domains/intelligence/components/plugins/plugin-origin-badge.js";

afterEach(() => {
  cleanup();
});

describe("PluginOriginBadge", () => {
  test("external plugin: shows External label with globe icon", () => {
    const { container, getByText } = render(<PluginOriginBadge external />);

    expect(getByText("External")).toBeTruthy();
    expect(container.querySelector(".lucide-globe")).toBeTruthy();
    expect(container.querySelector(".lucide-hard-drive")).toBeNull();
  });

  test("local plugin: shows Local label with drive icon", () => {
    const { container, getByText } = render(
      <PluginOriginBadge external={false} />,
    );

    expect(getByText("Local")).toBeTruthy();
    expect(container.querySelector(".lucide-hard-drive")).toBeTruthy();
    expect(container.querySelector(".lucide-globe")).toBeNull();
  });
});
