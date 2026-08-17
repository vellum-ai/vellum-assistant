import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";

import { SttLanguagePicker } from "./stt-language-picker";

/**
 * The spoken-language picker, as the STT settings form and the voice room
 * render it (standalone content, no modal chrome of its own).
 *
 * Keyboard: focus lands in the search field, ArrowDown/ArrowUp/Home/End move
 * the highlight, Enter picks it, and typing filters. Escape belongs to the
 * host, so it does nothing here.
 */
const meta: Meta<typeof SttLanguagePicker> = {
  title: "Speech/SttLanguagePicker",
  component: SttLanguagePicker,
  args: {
    currentCode: "es",
    configuredProviderId: "vellum",
    suggestedCode: "ta",
    selecting: false,
  },
  argTypes: {
    selectLanguage: { control: false },
    onDone: { control: false },
  },
  decorators: [
    (Story) => (
      <div className="w-[420px] p-6">
        <Story />
      </div>
    ),
  ],
};

export default meta;

type Story = StoryObj<typeof SttLanguagePicker>;

/**
 * Owns the picked code locally so the check mark follows a pick, the way it
 * does once the write lands in the app.
 */
export const Default: Story = {
  render: function Render(args) {
    const [code, setCode] = useState(args.currentCode);
    return (
      <SttLanguagePicker
        {...args}
        currentCode={code}
        selectLanguage={setCode}
        onDone={() => {}}
      />
    );
  },
};

/** A write is in flight: the list dims but stays pickable. */
export const Selecting: Story = {
  ...Default,
  args: { selecting: true },
};
