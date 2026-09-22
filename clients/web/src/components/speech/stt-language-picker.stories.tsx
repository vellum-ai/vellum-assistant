import type { Meta, StoryObj } from "@storybook/react-vite";
import { useArgs } from "storybook/preview-api";

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
 * A pick writes back to the `currentCode` arg, so the check mark follows it the
 * way it does once the write lands in the app, and Controls stays in step.
 */
export const Default: Story = {
  render: function Render(args) {
    const [{ currentCode }, updateArgs] = useArgs<{ currentCode: string }>();
    return (
      <SttLanguagePicker
        {...args}
        currentCode={currentCode}
        selectLanguage={(code) => updateArgs({ currentCode: code })}
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
