import type { Meta, StoryObj } from "@storybook/react-vite";
import { useEffect, type ComponentProps } from "react";
import { changeLocale, SUPPORTED_LOCALES, type SupportedLocale } from "@/i18n";
import { captureError } from "@/lib/sentry/capture-error";

import { CompanionIntro } from "./companion-intro";
import { introPermission as permission } from "./companion-intro-fixtures";

type PreviewProps = ComponentProps<typeof CompanionIntro> & {
  locale?: SupportedLocale;
};
function Preview({ locale = "en", ...args }: PreviewProps) {
  useEffect(() => {
    void changeLocale(locale).catch((error) =>
      captureError(error, { context: "companionIntro.storyLocale" }),
    );
  }, [locale]);
  return (
    <div className="relative h-[400px] w-[380px]">
      <CompanionIntro {...args} />
    </div>
  );
}

const meta = {
  title: "Components/CompanionIntroPermissions",
  component: CompanionIntro,
  parameters: { layout: "centered" },
  args: { locale: "en" },
  argTypes: { locale: { control: "select", options: SUPPORTED_LOCALES } },
  render: (args) => <Preview {...args} />,
} satisfies Meta<PreviewProps>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Microphone: Story = {
  args: { beat: "talk", permission: permission("microphone") },
};
export const Shortcut: Story = {
  args: { beat: "key", permission: permission("inputMonitoring") },
};
export const ScreenSharing: Story = {
  args: { beat: "share", permission: permission("screen", "denied") },
};
export const DeniedMicrophone: Story = {
  args: { beat: "try", permission: permission("microphone", "denied") },
};
export const Restricted: Story = {
  args: {
    beat: "key",
    permission: permission("inputMonitoring", "restricted"),
  },
};
export const Waiting: Story = {
  args: {
    beat: "talk",
    permission: {
      kind: "microphone",
      state: { phase: "requesting" },
      enable: () => {},
    },
  },
};
export const Failed: Story = {
  args: {
    beat: "talk",
    permission: {
      kind: "microphone",
      state: { phase: "error" },
      enable: () => {},
    },
  },
};
