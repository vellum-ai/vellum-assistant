import type { Meta, StoryObj } from "@storybook/react-vite";
import { useRef, useState } from "react";
import { useArgs } from "storybook/preview-api";
import { expect, fn, userEvent, within } from "storybook/test";
import { Settings } from "lucide-react";
import { Button } from "@vellumai/design-library/components/button";
import { createInstance } from "i18next";
import ICU from "i18next-icu";
import { I18nextProvider } from "react-i18next";

import { useTranslation } from "@/i18n";
import { FALLBACK_CATALOGS } from "@/i18n/catalogs";
import { i18nextInitOptions } from "@/i18n/config";
import ruChat from "@/i18n/locales/ru/chat.json";

import {
  ChatsSettingsModal,
  type ChatsSettingsModalProps,
  type ChatsSettingsValues,
} from "./chats-settings-modal";

const DEFAULTS: ChatsSettingsValues = {
  autoArchive: { enabled: false, afterDays: 7 },
  newMessageEnabled: true,
};

const meta = {
  title: "Chat/Chats Settings Modal",
  component: ChatsSettingsModal,
  parameters: { layout: "fullscreen" },
  args: {
    open: true,
    state: { status: "ready", values: DEFAULTS },
    saveStatus: "idle",
    onOpenChange: fn(),
    onSave: fn(),
    onRetryLoad: fn(),
  },
  argTypes: {
    saveStatus: { control: "select", options: ["idle", "pending", "error"] },
    onOpenChange: { control: false },
    onSave: { control: false },
    onRetryLoad: { control: false },
    returnFocusRef: { control: false },
  },
  render: function Render(args) {
    const [, updateArgs] = useArgs<ChatsSettingsModalProps>();
    return (
      <ChatsSettingsModal
        {...args}
        onOpenChange={(open) => {
          args.onOpenChange(open);
          updateArgs({ open });
        }}
      />
    );
  },
} satisfies Meta<typeof ChatsSettingsModal>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const AutoArchiveEnabled: Story = {
  args: {
    state: {
      status: "ready",
      values: { ...DEFAULTS, autoArchive: { enabled: true, afterDays: 14 } },
    },
  },
};

export const NotificationsOff: Story = {
  args: {
    state: {
      status: "ready",
      values: { ...DEFAULTS, newMessageEnabled: false },
    },
  },
};

export const Loading: Story = { args: { state: { status: "loading" } } };
export const LoadFailure: Story = { args: { state: { status: "error" } } };
export const UnsupportedAssistant: Story = {
  args: { state: { status: "unsupported" } },
};

export const Mobile: Story = {
  globals: { viewport: { value: "sbMobile", isRotated: false } },
};
export const NarrowMobile: Story = {
  globals: { viewport: { value: "sbNarrowPhone", isRotated: false } },
};

const russianPreview = createInstance().use(new ICU());

export const RussianNarrowMobile: Story = {
  globals: { viewport: { value: "sbNarrowPhone", isRotated: false } },
  beforeEach: async () => {
    await russianPreview.init(
      i18nextInitOptions("ru", {
        en: FALLBACK_CATALOGS,
        ru: { ...FALLBACK_CATALOGS, chat: ruChat },
      }),
    );
  },
  decorators: [
    (Story) => (
      <I18nextProvider i18n={russianPreview}>
        <Story />
      </I18nextProvider>
    ),
  ],
};

export const Dark: Story = { globals: { theme: "dark" } };
export const Light: Story = { globals: { theme: "light" } };

// Interaction fixtures keep their state local because the test runner does not turn the args channel.
function SaveAttempt({
  outcome,
  ...args
}: ChatsSettingsModalProps & { outcome: "pending" | "error" }) {
  const [saveStatus, setSaveStatus] = useState(args.saveStatus);
  const [open, setOpen] = useState(args.open);
  return (
    <ChatsSettingsModal
      {...args}
      open={open}
      saveStatus={saveStatus}
      onOpenChange={setOpen}
      onSave={(changes) => {
        args.onSave(changes);
        setSaveStatus(outcome);
      }}
    />
  );
}

export const DirtyForm: Story = {
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body);
    await userEvent.click(
      page.getByRole("switch", { name: "Auto Archive Chats" }),
    );
    await expect(page.getByRole("button", { name: "Confirm" })).toBeEnabled();
  },
};

export const SavePending: Story = {
  render: (args) => <SaveAttempt {...args} outcome="pending" />,
  parameters: { controls: { disable: true } },
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body);
    await userEvent.click(
      page.getByRole("switch", { name: "Auto Archive Chats" }),
    );
    await userEvent.click(page.getByRole("button", { name: "Confirm" }));
    await expect(page.getByRole("button", { name: "Cancel" })).toBeDisabled();
  },
};

export const SaveFailure: Story = {
  render: (args) => <SaveAttempt {...args} outcome="error" />,
  parameters: { controls: { disable: true } },
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body);
    await userEvent.click(
      page.getByRole("switch", { name: "Auto Archive Chats" }),
    );
    await userEvent.click(page.getByRole("button", { name: "Confirm" }));
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(
      page.getByRole("switch", { name: "Auto Archive Chats" }),
    ).toBeChecked();
  },
};

function InteractionFixture(args: ChatsSettingsModalProps) {
  const { t } = useTranslation("chat");
  const gearRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        ref={gearRef}
        variant="ghost"
        aria-label={t("chatsSettingsModal.title")}
        onClick={() => setOpen(true)}
      >
        <Settings />
      </Button>
      <ChatsSettingsModal
        {...args}
        open={open}
        onOpenChange={setOpen}
        returnFocusRef={gearRef}
      />
    </>
  );
}

export const KeyboardAndSelect: Story = {
  render: (args) => <InteractionFixture {...args} />,
  parameters: { controls: { disable: true } },
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body);
    const gear = page.getByRole("button", { name: "Chats Settings" });
    await userEvent.click(gear);
    await userEvent.click(
      page.getByRole("switch", { name: "Auto Archive Chats" }),
    );
    await userEvent.click(
      page.getByRole("combobox", { name: "Time to Archive" }),
    );
    await userEvent.click(page.getByRole("option", { name: "30 days" }));
    await expect(
      page.getByRole("dialog", { name: "Chats Settings" }),
    ).toBeVisible();
    await expect(
      page.getByRole("combobox", { name: "Time to Archive" }),
    ).toHaveTextContent("30 days");
    await userEvent.keyboard("{Escape}");
    await expect(gear).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    await expect(
      page.getByRole("combobox", { name: "Time to Archive" }),
    ).toHaveTextContent("7 days");
  },
};
