import type { Meta, StoryObj } from "@storybook/react-vite";
import { userEvent, within } from "storybook/test";

import { channelverificationsessionsStatusGetQueryKey } from "@/generated/daemon/@tanstack/react-query.gen";
import { withAvatarRaster } from "./channel-avatar-story-decorator";
import { DiscordSetupWizard } from "./discord-setup-wizard";

const ASSISTANT_ID = "asst_story";

const meta: Meta<typeof DiscordSetupWizard> = {
  title: "Contacts/DiscordSetupWizard",
  component: DiscordSetupWizard,
  args: {
    assistantId: ASSISTANT_ID,
    assistantName: "Example Assistant",
  },
  // 400px matches the drawer this renders in: `chat-content-layout.tsx` mounts
  // the channel setup panel in an `AnimatedRightDrawer` with `defaultWidth` and
  // `minWidth` both 400.
  decorators: [
    withAvatarRaster(ASSISTANT_ID, true),
    (Story) => (
      <div style={{ width: 400, margin: "2rem auto" }}>
        <Story />
      </div>
    ),
  ],
};

export default meta;

type Story = StoryObj<typeof DiscordSetupWizard>;

const INVITE_URL =
  "https://discord.com/oauth2/authorize?client_id=000000000000000001";

/**
 * Walk forward the way a user does. There is no prop to jump straight to a
 * step: a story that renders a screen no real path produces would assert
 * against a state the wizard cannot actually reach. The one exception the
 * wizard itself makes is a successful save, which advances to the invite
 * step on its own.
 */
async function goToConnect(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  await userEvent.click(
    canvas.getByRole("button", { name: /I have my token/i }),
  );
}

/** Step 1: create the app, with the App Verification and intents notes. */
export const CreateApp: Story = {};

/** Step 2, reached the way a user reaches it. */
export const Connect: Story = {
  play: async ({ canvasElement }) => {
    await goToConnect(canvasElement);
  },
};

export const SaveFailed: Story = {
  args: {
    saveStatus: "error",
    saveError: "Discord rejected the bot token (401 Unauthorized).",
  },
  play: async ({ canvasElement }) => {
    await goToConnect(canvasElement);
    const canvas = within(canvasElement);
    await userEvent.type(canvas.getByLabelText(/Bot token/i), "not-a-token");
  },
};

/** Step 3: the save succeeded, so the wizard advanced here on its own. */
export const Invite: Story = {
  args: { saveStatus: "success", inviteUrl: INVITE_URL },
};

/**
 * Step 3 without an install link: the daemon could not read one back from
 * the application's install settings, so there is nothing to open and
 * nothing to confirm.
 */
export const InviteMissingUrl: Story = {
  args: { saveStatus: "success" },
};

/**
 * Step 4: the user confirmed the bot joined. Success pairs with the
 * connected-but-not-verified handoff, because a stored token alone does not
 * make the bot answer its owner under the default trusted-contacts policy.
 */
export const Finish: Story = {
  args: {
    saveStatus: "success",
    inviteUrl: INVITE_URL,
    onVerifyRequest: () => {},
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      canvas.getByRole("button", { name: /I've added the bot/i }),
    );
  },
};

/**
 * Step 4 on a surface with no conversation to signal (the Channels tab):
 * no Verify me button, so the copy says what to type in chat instead.
 */
export const FinishWithoutChat: Story = {
  args: { saveStatus: "success", inviteUrl: INVITE_URL },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      canvas.getByRole("button", { name: /I've added the bot/i }),
    );
  },
};

/**
 * Step 4 for a guardian whose binding survived a disconnect and reconnect:
 * already verified, so the handoff warning gives way to a second success.
 */
export const FinishVerified: Story = {
  args: { saveStatus: "success", inviteUrl: INVITE_URL },
  decorators: [
    withAvatarRaster(ASSISTANT_ID, true, (client) => {
      client.setQueryData(
        channelverificationsessionsStatusGetQueryKey({
          path: { assistant_id: ASSISTANT_ID },
          query: { channel: "discord" },
        }),
        { success: true, bound: true },
      );
    }),
  ],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      canvas.getByRole("button", { name: /I've added the bot/i }),
    );
  },
};
