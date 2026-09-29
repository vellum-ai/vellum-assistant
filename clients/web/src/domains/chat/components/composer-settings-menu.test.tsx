import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { ComposerConfigurationContent } from "@/domains/chat/components/composer-settings-menu";
import { composerConfigurationFixture } from "@/domains/chat/components/composer-configuration.test-utils";

afterEach(cleanup);
describe("composer configuration menu", () => {
  test.each([false, true])(
    "groups start collapsed and expand one at a time (mobile: %s)",
    (mobile) => {
      render(
        <ComposerConfigurationContent
          configuration={composerConfigurationFixture()}
          mobile={mobile}
          attachments={null}
        />,
      );
      expect(screen.queryByRole("radiogroup")).toBeNull();
      const autonomy = screen.getByRole("button", {
        name: "Autonomy",
      });
      const model = screen.getByRole("button", { name: "Model" });
      expect(autonomy.getAttribute("aria-expanded")).toBe("false");
      fireEvent.click(autonomy);
      expect(screen.getByRole("radiogroup", { name: "Autonomy" })).toBeTruthy();
      fireEvent.click(model);
      expect(autonomy.getAttribute("aria-expanded")).toBe("false");
      expect(screen.getByRole("radiogroup", { name: "Model" })).toBeTruthy();
      fireEvent.click(model);
      expect(model.getAttribute("aria-expanded")).toBe("false");
    },
  );
  test.each([false, true])(
    "Hands-off selects immediately (mobile: %s)",
    (mobile) => {
      const configuration = composerConfigurationFixture();
      configuration.selectAutonomy = mock(async () => true);
      render(
        <ComposerConfigurationContent
          configuration={configuration}
          mobile={mobile}
          attachments={null}
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: "Autonomy" }));
      fireEvent.click(screen.getByRole("radio", { name: "Hands-off" }));
      expect(configuration.selectAutonomy).toHaveBeenCalledWith("high");
      expect(configuration.selectAutonomy).toHaveBeenCalledTimes(1);
      expect(
        screen.queryByRole("button", { name: "Use Hands-off" }),
      ).toBeNull();
    },
  );
  test("All models groups Open Beta as built-in and returns to the expanded model group", () => {
    const configuration = composerConfigurationFixture();
    configuration.selectMode = mock(async () => true);
    configuration.setOpen = mock(() => {});
    render(
      <ComposerConfigurationContent
        configuration={configuration}
        mobile={false}
        attachments={null}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Model" }));
    fireEvent.click(screen.getByRole("button", { name: "All models (6)" }));
    const builtIn = screen.getByRole("region", { name: "Built-in" });
    fireEvent.click(within(builtIn).getByRole("button", { name: /Open Beta/ }));
    expect(configuration.selectMode).toHaveBeenCalledWith("os-beta");
    expect(screen.getByRole("radiogroup", { name: "Model" })).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: "Autonomy" })
        .getAttribute("aria-expanded"),
    ).toBe("false");
    expect(configuration.setOpen).not.toHaveBeenCalled();
  });
  test("All models has no search or costs and reuses the creation action", () => {
    const configuration = composerConfigurationFixture();
    configuration.profiles.push(
      ...[1, 2, 3].map((i) => ({
        name: `custom-${i}`,
        label: `Custom ${i}`,
        provider: "anthropic" as const,
        model: "claude-fable-5",
      })),
    );
    configuration.newMode = mock(() => {});
    render(
      <ComposerConfigurationContent
        configuration={configuration}
        mobile
        attachments={null}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Model" }));
    fireEvent.click(screen.getByRole("button", { name: "More (4)" }));
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByRole("region", { name: "Custom" })).toBeTruthy();
    expect(screen.queryByText(/\$/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "New" }));
    expect(configuration.newMode).toHaveBeenCalledTimes(1);
  });
  test("only a custom favorite with a known expensive tier shows cost", () => {
    const configuration = composerConfigurationFixture();
    const custom = {
      name: "research",
      label: "Research",
      source: "user" as const,
      provider: "anthropic" as const,
      model: "claude-fable-5",
    };
    configuration.profiles.push(custom);
    configuration.favorites[4] = custom;
    configuration.modeCosts = {
      ...configuration.modeCosts,
      research: { kind: "tier", tier: 3 },
    };
    const { rerender } = render(
      <ComposerConfigurationContent
        configuration={configuration}
        mobile={false}
        attachments={null}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Model" }));
    expect(screen.getByRole("radio", { name: "Research $$$" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Quality" })).toBeTruthy();
    configuration.modeCosts.research = { kind: "unknown" };
    rerender(
      <ComposerConfigurationContent
        configuration={configuration}
        mobile={false}
        attachments={null}
      />,
    );
    expect(screen.getByRole("radio", { name: "Research" })).toBeTruthy();
    expect(screen.queryByText(/\$/)).toBeNull();
  });
  test("Escape from All models returns to the group before closing the menu", () => {
    const configuration = composerConfigurationFixture();
    configuration.setOpen = mock(() => {});
    render(
      <ComposerConfigurationContent
        configuration={configuration}
        mobile={false}
        attachments={null}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Model" }));
    fireEvent.click(screen.getByRole("button", { name: "All models (6)" }));
    fireEvent.keyDown(screen.getByRole("button", { name: "Back" }), {
      key: "Escape",
    });
    expect(screen.getByRole("radiogroup", { name: "Model" })).toBeTruthy();
    expect(configuration.setOpen).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole("button", { name: "Model" }), {
      key: "Escape",
    });
    expect(configuration.setOpen).toHaveBeenCalledWith(false);
  });
  test("legacy preferences explain the update without a visibility toggle", () => {
    const configuration = composerConfigurationFixture();
    configuration.modeCosts = undefined;
    configuration.preferencesAvailable = false;
    configuration.supportsPreferences = false;
    render(
      <ComposerConfigurationContent
        configuration={configuration}
        mobile={false}
        attachments={null}
      />,
    );
    expect(screen.queryByText("Unknown")).toBeNull();
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.getByText(/Update your assistant/)).toBeTruthy();
  });
});
