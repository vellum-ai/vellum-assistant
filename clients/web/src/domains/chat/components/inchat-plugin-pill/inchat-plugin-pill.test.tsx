/**
 * Tests for `InChatPluginPill`. Mounted via `@testing-library/react` (happy-dom).
 * The design-library primitives are real; only the data hook, the mobile check,
 * and the router are mocked.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { routes } from "@/utils/routes";

const isMobileRef = { value: false };
mock.module("@/hooks/use-is-mobile", () => ({
  useIsMobile: () => isMobileRef.value,
  MOBILE_MEDIA_QUERY: "(max-width: 767px)",
}));

const navigateSpy = mock((_href: string) => {});
mock.module("react-router", () => ({
  useNavigate: () => navigateSpy,
}));

interface EffectivePlugin {
  name: string;
  label: string;
  selected: boolean;
}
const effectiveRef = {
  value: {
    plugins: [] as EffectivePlugin[],
    selectedCount: 0,
    total: 0,
    isDefault: true,
  },
};
mock.module(
  "@/domains/chat/components/inchat-plugin-pill/use-effective-chat-plugins",
  () => ({ useEffectiveChatPlugins: () => effectiveRef.value }),
);

const { InChatPluginPill } = await import("./inchat-plugin-pill");

function setEffective(
  plugins: EffectivePlugin[],
  overrides: Partial<(typeof effectiveRef)["value"]> = {},
) {
  const selected = plugins.filter((p) => p.selected);
  effectiveRef.value = {
    plugins,
    selectedCount: overrides.selectedCount ?? selected.length,
    total: overrides.total ?? plugins.length,
    isDefault: overrides.isDefault ?? false,
  };
}

function renderPill() {
  return render(
    <InChatPluginPill assistantId="asst-1" conversationId="conv-1" />,
  );
}

beforeEach(() => {
  isMobileRef.value = false;
  navigateSpy.mockClear();
  effectiveRef.value = {
    plugins: [],
    selectedCount: 0,
    total: 0,
    isDefault: true,
  };
});

afterEach(() => {
  cleanup();
});

describe("InChatPluginPill", () => {
  test("renders nothing when no plugins are installed", () => {
    setEffective([], { total: 0 });
    const { container } = renderPill();
    expect(container.textContent).toBe("");
  });

  test("pill shows the active plugin count (pluralized)", () => {
    setEffective([
      { name: "a", label: "Alpha", selected: true },
      { name: "b", label: "Beta", selected: true },
      { name: "c", label: "Gamma", selected: false },
    ]);
    renderPill();
    expect(screen.getByText("2 plugins")).toBeTruthy();
  });

  test("pill uses the singular for one active plugin", () => {
    setEffective([
      { name: "a", label: "Alpha", selected: true },
      { name: "b", label: "Beta", selected: false },
    ]);
    renderPill();
    expect(screen.getByText("1 plugin")).toBeTruthy();
  });

  test("opening lists the active plugins (read-only) and Manage", () => {
    setEffective([
      { name: "a", label: "Alpha", selected: true },
      { name: "b", label: "Beta", selected: false },
      { name: "c", label: "Gamma", selected: true },
    ]);
    renderPill();

    fireEvent.click(screen.getByText("2 plugins"));

    // Active plugins are listed; inactive ones are not.
    expect(screen.getByText("Alpha")).toBeTruthy();
    expect(screen.getByText("Gamma")).toBeTruthy();
    expect(screen.queryByText("Beta")).toBeNull();
    expect(
      screen.getByText("Changing plugin settings can incur high costs."),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Manage" })).toBeTruthy();
  });

  test("Manage navigates to the plugins page", () => {
    setEffective([{ name: "a", label: "Alpha", selected: true }]);
    renderPill();

    fireEvent.click(screen.getByText("1 plugin"));
    fireEvent.click(screen.getByRole("button", { name: "Manage" }));

    expect(navigateSpy).toHaveBeenCalledTimes(1);
    expect(navigateSpy).toHaveBeenCalledWith(routes.plugins);
  });

  test("empty active set still shows header + Manage + caption, no rows", () => {
    setEffective(
      [
        { name: "a", label: "Alpha", selected: false },
        { name: "b", label: "Beta", selected: false },
      ],
      { selectedCount: 0 },
    );
    renderPill();

    fireEvent.click(screen.getByText("0 plugins"));

    expect(screen.getByText("Plugins")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Manage" })).toBeTruthy();
    expect(
      screen.getByText("Changing plugin settings can incur high costs."),
    ).toBeTruthy();
    // No plugin rows for an empty active set.
    expect(screen.queryByText("Alpha")).toBeNull();
    expect(screen.queryByText("Beta")).toBeNull();
  });
});
