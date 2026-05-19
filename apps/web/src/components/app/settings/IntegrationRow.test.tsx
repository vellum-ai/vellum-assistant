/**
 * Tests for the `IntegrationConfigureMenu` extracted from `IntegrationRow`.
 *
 * Verifies the mobile vs desktop branch — desktop renders a Radix Popover
 * with `role="menu"` content; mobile renders a Radix Dialog (BottomSheet).
 * Selecting Edit connections / Disable forwards the corresponding callback.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { cleanup, fireEvent, render, screen } from "@/test-utils.js";

import { IntegrationConfigureMenu } from "@/components/app/settings/IntegrationRow.js";

beforeEach(() => {
  document.body.innerHTML = "";
  document.body.removeAttribute("style");
  document.body.removeAttribute("data-scroll-locked");
});

afterEach(cleanup);

describe("IntegrationConfigureMenu", () => {
  test("desktop branch renders Radix Popover menu with Edit connections / Disable rows", () => {
    const onEditConnections = mock(() => {});
    const onDisable = mock(() => {});
    render(
      <IntegrationConfigureMenu
        displayName="GitHub"
        open
        onOpenChange={() => {}}
        onEditConnections={onEditConnections}
        onDisable={onDisable}
        disablePending={false}
        isMobile={false}
      />,
    );
    expect(screen.getByRole("menu")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: "Edit connections" }));
    expect(onEditConnections).toHaveBeenCalledTimes(1);
  });

  test("mobile branch renders BottomSheet (role=dialog) with Edit connections / Disable rows", () => {
    const onEditConnections = mock(() => {});
    const onDisable = mock(() => {});
    render(
      <IntegrationConfigureMenu
        displayName="GitHub"
        open
        onOpenChange={() => {}}
        onEditConnections={onEditConnections}
        onDisable={onDisable}
        disablePending={false}
        isMobile
      />,
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog).toBeInTheDocument();
    expect(dialog.getAttribute("data-state")).toBe("open");
    // Mobile sheet uses the integration name as a visible Title for context.
    expect(screen.getByText("GitHub")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Disable" }));
    expect(onDisable).toHaveBeenCalledTimes(1);
  });

  test("mobile branch suppresses the Disable click when disablePending is true", () => {
    const onDisable = mock(() => {});
    render(
      <IntegrationConfigureMenu
        displayName="GitHub"
        open
        onOpenChange={() => {}}
        onEditConnections={() => {}}
        onDisable={onDisable}
        disablePending
        isMobile
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Disable" }));
    expect(onDisable).not.toHaveBeenCalled();
  });
});
