import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { useState, type SetStateAction } from "react";
import { ComposerSettingsSurface } from "@/domains/chat/components/composer-settings-menu";
import { composerConfigurationFixture } from "@/domains/chat/components/composer-configuration.test-utils";
import { favoriteModes } from "@/domains/chat/utils/composer-configuration";

function useDemoConfiguration({
  manyModes = false,
  state: initialState = "ready",
}: {
  mobile?: boolean;
  manyModes?: boolean;
  state?: "ready" | "loading" | "legacy";
}) {
  const [state, setState] = useState(() => {
    const base = composerConfigurationFixture();
    if (initialState === "loading") {
      base.modeReady = false;
      base.autonomyReady = false;
      base.autonomy = null;
      base.mode = null;
    }
    if (initialState === "legacy") {
      base.supportsPreferences = false;
      base.preferencesAvailable = false;
    }
    if (manyModes) {
      base.profiles = [
        ...base.profiles,
        ...Array.from({ length: 3 }, (_, i) => ({
          name: `custom-${i}`,
          label: ["Research", "Creative", "Code"][i],
          description: [
            "Strong at synthesis. Slower, higher cost.",
            "Expressive writing.",
            "Built for coding.",
          ][i],
          provider: "anthropic" as const,
          model: "claude-fable-5",
          source: "user" as const,
        })),
      ];
      base.allProfiles = base.profiles;
    }
    return base;
  });
  const configuration = {
    ...state,
    favorites: favoriteModes(
      state.preferences.favoriteModeIds,
      state.profiles,
      state.mode,
    ),
    selectMode: async (mode: string) => {
      setState((current) => ({
        ...current,
        mode,
        preferences: {
          ...current.preferences,
          favoriteModeIds: favoriteModes(
            current.preferences.favoriteModeIds,
            current.profiles,
            mode,
          ).map((entry) => entry.name),
        },
      }));
      return true;
    },
    selectAutonomy: async (autonomy: NonNullable<typeof state.autonomy>) => {
      setState((current) => ({ ...current, autonomy }));
      return true;
    },
  };
  return {
    ...configuration,
    setOpen: (next: SetStateAction<boolean>) =>
      setState((current) => {
        const open = typeof next === "function" ? next(current.open) : next;
        return { ...current, open };
      }),
  };
}

function SurfaceDemo(props: Parameters<typeof useDemoConfiguration>[0]) {
  const { mobile = false } = props;
  const configuration = useDemoConfiguration(props);
  return (
    <div className="flex min-h-screen flex-col justify-end bg-[var(--surface-base)] p-6">
      <div className="max-w-3xl rounded-[18px] border border-[var(--border-subtle)] bg-[var(--surface-lift)] p-4">
        <div className="h-16" />
        <div className="flex items-center gap-2">
          <ComposerSettingsSurface
            mobile={mobile}
            configuration={configuration}
            disabled={false}
            pickers={{
              camera: () => {},
              photos: () => {},
              files: () => configuration.setOpen(false),
            }}
          />
        </div>
      </div>
    </div>
  );
}

const meta = {
  title: "Chat/ComposerSettingsMenu",
  component: SurfaceDemo,
  args: { manyModes: true },
  globals: { theme: "dark" },
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof SurfaceDemo>;
export default meta;
type Story = StoryObj<typeof meta>;

const page = (canvasElement: HTMLElement) =>
  within(canvasElement.ownerDocument.body);
async function expand(canvasElement: HTMLElement, name: "Autonomy" | "Model") {
  await userEvent.click(page(canvasElement).getByRole("button", { name }));
}
async function allModels(canvasElement: HTMLElement, mobile = false) {
  await expand(canvasElement, "Model");
  await userEvent.click(
    page(canvasElement).getByRole("button", {
      name: mobile ? /More/ : /All models \(/,
    }),
  );
}

export const Desktop: Story = {};
export const DesktopAutonomyExpanded: Story = {
  play: async ({ canvasElement }) => expand(canvasElement, "Autonomy"),
};
export const DesktopModelExpanded: Story = {
  play: async ({ canvasElement }) => expand(canvasElement, "Model"),
};
export const AllModes: Story = {
  name: "All Models",
  play: async ({ canvasElement }) => allModels(canvasElement),
};
export const Mobile: Story = {
  args: { mobile: true },
  globals: { viewport: { value: "sbMobile", isRotated: false } },
};
export const MobileAutonomyExpanded: Story = {
  ...Mobile,
  play: async ({ canvasElement }) => expand(canvasElement, "Autonomy"),
};
export const MobileModelExpanded: Story = {
  ...Mobile,
  play: async ({ canvasElement }) => expand(canvasElement, "Model"),
};
export const MobileAllModels: Story = {
  ...Mobile,
  play: async ({ canvasElement }) => {
    await expand(canvasElement, "Model");
    const body = page(canvasElement);
    const sheet = body.getByRole("dialog");
    const before = sheet.getBoundingClientRect().height;
    await userEvent.click(body.getByRole("button", { name: /More/ }));
    await expect(
      Math.abs(sheet.getBoundingClientRect().height - before),
    ).toBeLessThanOrEqual(1);
    await expect(
      body.getByRole("region", { name: "All models" }),
    ).toBeVisible();
  },
};
export const NarrowMobile: Story = {
  ...MobileModelExpanded,
  globals: { viewport: { value: "sbNarrowPhone", isRotated: false } },
};
export const ModeSelection: Story = {
  play: async ({ canvasElement }) => {
    await expand(canvasElement, "Model");
    const modes = within(
      page(canvasElement).getByRole("radiogroup", { name: "Model" }),
    );
    const order = modes
      .getAllByRole("radio")
      .map((button) => button.textContent);
    for (const name of ["Fast", "Budget", "Quality"]) {
      await userEvent.click(modes.getByRole("radio", { name }));
      await expect(
        modes.getAllByRole("radio").map((button) => button.textContent),
      ).toEqual(order);
    }
  },
};
export const CustomFavorite: Story = {
  play: async ({ canvasElement }) => {
    await allModels(canvasElement);
    await userEvent.click(
      page(canvasElement).getByRole("button", { name: /Research/ }),
    );
    await expect(
      page(canvasElement).getByRole("radio", { name: "Research" }),
    ).toHaveAttribute("aria-checked", "true");
  },
};
export const Loading: Story = { args: { state: "loading" } };
export const OlderAssistant: Story = { args: { state: "legacy" } };
export const DarkDesktop: Story = {};
export const LightDesktop: Story = {
  globals: { theme: "light" },
  ...DesktopModelExpanded,
};
export const PopoverInteraction: Story = {};
export const ClosedComposer: Story = {
  play: async ({ canvasElement }) => {
    await userEvent.keyboard("{Escape}");
    const composer = within(canvasElement);
    await expect(composer.getAllByRole("button")).toHaveLength(1);
    await expect(
      composer.getByRole("button", { name: "Attachments and settings" }),
    ).toBeVisible();
  },
};
export const MobileClosedComposer: Story = {
  ...Mobile,
  play: async ({ canvasElement }) => {
    await userEvent.click(
      page(canvasElement).getByRole("button", { name: "Close settings" }),
    );
    const composer = within(canvasElement);
    await expect(composer.getAllByRole("button")).toHaveLength(1);
    await expect(
      composer.getByRole("button", { name: "Attachments and settings" }),
    ).toBeVisible();
  },
};
export const HandsOff: Story = {
  play: async ({ canvasElement }) => {
    await expand(canvasElement, "Autonomy");
    const handsOff = page(canvasElement).getByRole("radio", {
      name: "Hands-off",
    });
    await userEvent.click(handsOff);
    await expect(handsOff).toHaveAttribute("aria-checked", "true");
  },
};
