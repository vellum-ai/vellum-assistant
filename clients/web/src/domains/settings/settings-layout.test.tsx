import { afterEach, describe, expect, mock, test } from "bun:test";

import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router";

import type { SidebarItem } from "@/components/sidebar-tree";

let assistantFlags: Record<string, boolean> = {};
let supportsBookmarks = false;
let supportsCredentials = false;
let nativeAndroid = false;

mock.module("@/stores/assistant-feature-flag-store", () => {
  const store = () => null;
  store.use = {
    settingsDeveloperNav: () => assistantFlags.settingsDeveloperNav ?? false,
  };
  return { useAssistantFeatureFlagStore: store };
});

mock.module("@/lib/backwards-compat/use-supports-bookmarks", () => ({
  useSupportsBookmarks: () => supportsBookmarks,
}));

mock.module("@/lib/backwards-compat/use-supports-credentials-settings", () => ({
  useSupportsCredentialsSettings: () => supportsCredentials,
}));

mock.module("@/stores/resolved-assistants-store", () => {
  const store = () => null;
  store.use = {
    activeAssistantId: () => "asst-active",
  };
  return { useResolvedAssistantsStore: store };
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

mock.module("@/runtime/platform-detection", () => ({
  useIsNativeAndroid: () => nativeAndroid,
}));

mock.module("@/components/sidebar-shell", () => ({
  SidebarShell: ({
    sidebar,
    children,
  }: {
    sidebar: ReactNode;
    children: ReactNode;
  }) => (
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
  supportsBookmarks = false;
  supportsCredentials = false;
  nativeAndroid = false;
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

  test("never renders a Security entry — two-factor auth lives on General", () => {
    render(
      <MemoryRouter initialEntries={["/assistant/settings"]}>
        <SettingsLayout />
      </MemoryRouter>,
    );

    expect(screen.queryByRole("link", { name: "Security" })).toBeNull();
  });

  test("renders Bookmarks only when the assistant supports the bookmark routes", () => {
    render(
      <MemoryRouter initialEntries={["/assistant/settings"]}>
        <SettingsLayout />
      </MemoryRouter>,
    );
    expect(screen.queryByRole("link", { name: "Bookmarks" })).toBeNull();
    cleanup();

    supportsBookmarks = true;
    render(
      <MemoryRouter initialEntries={["/assistant/settings"]}>
        <SettingsLayout />
      </MemoryRouter>,
    );
    expect(screen.getByRole("link", { name: "Bookmarks" })).not.toBeNull();
  });

  test("renders Credentials only when the assistant serves the credentials routes", () => {
    render(
      <MemoryRouter initialEntries={["/assistant/settings"]}>
        <SettingsLayout />
      </MemoryRouter>,
    );
    expect(screen.queryByRole("link", { name: "Credentials" })).toBeNull();
    cleanup();

    supportsCredentials = true;
    render(
      <MemoryRouter initialEntries={["/assistant/settings"]}>
        <SettingsLayout />
      </MemoryRouter>,
    );
    expect(screen.getByRole("link", { name: "Credentials" })).not.toBeNull();
  });

  test("renders Notifications only in the native Android app", () => {
    render(
      <MemoryRouter initialEntries={["/assistant/settings"]}>
        <SettingsLayout />
      </MemoryRouter>,
    );
    expect(screen.queryByRole("link", { name: "Notifications" })).toBeNull();
    cleanup();

    nativeAndroid = true;
    render(
      <MemoryRouter initialEntries={["/assistant/settings"]}>
        <SettingsLayout />
      </MemoryRouter>,
    );
    expect(screen.getByRole("link", { name: "Notifications" })).not.toBeNull();
  });
});
