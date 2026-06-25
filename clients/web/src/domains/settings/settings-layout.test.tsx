import { afterEach, describe, expect, mock, test } from "bun:test";

import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router";

import type { SidebarItem } from "@/components/sidebar-tree";

let assistantFlags: Record<string, boolean> = {};

mock.module("@/stores/assistant-feature-flag-store", () => {
  const store = () => null;
  store.use = {
    settingsDeveloperNav: () => assistantFlags.settingsDeveloperNav ?? false,
  };
  return { useAssistantFeatureFlagStore: store };
});

mock.module("@/stores/client-feature-flag-store", () => {
  const store = () => null;
  store.use = {
    platformNotifications: () => false,
    bookmarks: () => false,
  };
  return { useClientFeatureFlagStore: store };
});

mock.module("@/hooks/use-platform-gate", () => ({
  usePlatformGate: () => "full",
}));

mock.module("@/hooks/use-onboarding-login", () => ({
  useOnboardingLogin: () => ({ login: () => {} }),
}));

mock.module("@/lib/auth/handle-logout", () => ({
  handleLogout: () => {},
}));

mock.module("@/stores/auth-store", () => ({
  useHasPlatformSession: () => false,
}));

mock.module("@/runtime/is-electron", () => ({
  isElectron: () => true,
}));

mock.module("@/components/sidebar-shell", () => ({
  SidebarShell: ({ sidebar, children }: { sidebar: ReactNode; children: ReactNode }) => (
    <div>
      {sidebar}
      {children}
    </div>
  ),
}));

mock.module("@/components/sidebar-tree", () => ({
  SidebarTree: ({ items }: { items: SidebarItem[] }) => (
    <nav aria-label="Settings navigation">
      {items.map((item) => (
        <a key={item.id} href={item.href}>
          {item.label}
        </a>
      ))}
    </nav>
  ),
}));

const { SettingsLayout } = await import("./settings-layout");

afterEach(() => {
  cleanup();
  assistantFlags = {};
});

describe("SettingsLayout", () => {
  test("does not render MCP as a top-level settings entry", () => {
    render(
      <MemoryRouter initialEntries={["/assistant/settings"]}>
        <SettingsLayout />
      </MemoryRouter>,
    );

    expect(screen.queryByRole("link", { name: "MCP" })).toBeNull();
    expect(screen.getByRole("link", { name: "Integrations" })).not.toBeNull();
  });
});
