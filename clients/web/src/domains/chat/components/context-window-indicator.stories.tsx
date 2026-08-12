import type { Meta, StoryObj } from "@storybook/react-vite";

import { showContextWindowIndicator } from "@/utils/composer-settings";

import { ContextWindowIndicator } from "./context-window-indicator";

/**
 * The composer's context-window fill ring. Opt-in via Settings → General →
 * Preferences, so every story enables the preference first.
 *
 * The ring reveals its detail on hover under a mouse and opens a bottom sheet
 * under a thumb: the input-capability axis, per `docs/PLATFORM_ADAPTATION.md`.
 * Switch the emulated pointer (DevTools → Rendering → "Emulate CSS media
 * feature pointer") and reload to compare the two presentations; the sheet is
 * the only branch carrying "Clear Context".
 */

const meta = {
  title: "Chat/ContextWindowIndicator",
  component: ContextWindowIndicator,
  parameters: { layout: "centered" },
  loaders: [
    () => {
      showContextWindowIndicator.save(true);
      return {};
    },
  ],
  decorators: [
    (Story) => (
      <div className="flex items-center rounded-lg bg-[var(--surface-lift)] p-4">
        <Story />
      </div>
    ),
  ],
  args: {
    assistantName: "Vellum",
    onClearContext: () => {},
  },
} satisfies Meta<typeof ContextWindowIndicator>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    usage: { tokens: 42_000, maxTokens: 200_000, fillRatio: 0.21 },
  },
};

export const Warning: Story = {
  args: {
    usage: { tokens: 130_000, maxTokens: 200_000, fillRatio: 0.65 },
  },
};

export const Critical: Story = {
  args: {
    usage: { tokens: 176_000, maxTokens: 200_000, fillRatio: 0.88 },
  },
};
