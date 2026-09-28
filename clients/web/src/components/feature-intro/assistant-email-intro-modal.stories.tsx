/**
 * The one-time feature intro pattern, with the Assistant Email intro as its
 * first use. A feature that lands announces itself once, over the chat, on
 * the first open of the app after it; dismissed by any route out, it never
 * returns on that device (`useFeatureIntroSeen`).
 *
 * `FeatureIntroModal` is the frame every intro shares: hero, serif title,
 * one line, and the feature's own pitch under it. The email intro draws the
 * assistant's character with a mailbox over the inbox's pitch: on a plan
 * without email, the design's perks, plan notice and Plans / Upgrade to
 * Super; on a plan with it, the perks and the way into setup.
 *
 * Nothing here talks to a platform: the avatar is a fixture, and the
 * handlers log to the Actions panel.
 */
import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";

import { avatarQueryKey } from "@/hooks/use-assistant-avatar";
import { withQueryCache } from "@/lib/story-query-cache";
import { BUNDLED_COMPONENTS } from "@/utils/avatar-bundled-components";
import { preloadBundledAvatarComponents } from "@/utils/use-bundled-avatar-components";

import { AssistantEmailIntroModal } from "./assistant-email-intro-modal";
import { FeatureIntroModal } from "./feature-intro-modal";

// The hero hangs the character off a dynamic import.
preloadBundledAvatarComponents();

const ASSISTANT_ID = "asst-email-intro-story";

/**
 * The avatar the hero draws, seeded under both spellings of the key, since
 * the hook appends a manifest-support flag the story cannot predict.
 */
const withAvatar = withQueryCache((client) => {
  for (const supportsManifest of [true, false]) {
    client.setQueryData([...avatarQueryKey(ASSISTANT_ID), supportsManifest], {
      components: BUNDLED_COMPONENTS,
      traits: { bodyShape: "blob", eyeStyle: "curious", color: "green" },
      customImageUrl: null,
    });
  }
});

const meta = {
  title: "Components/FeatureIntroModal",
  component: AssistantEmailIntroModal,
  decorators: [withAvatar],
  parameters: { layout: "fullscreen" },
  args: {
    open: true,
    onOpenChange: fn(),
    assistantId: ASSISTANT_ID,
    assistantName: "Mel",
    rootDomain: "vellum.me",
    locked: true,
    onUpgrade: fn(),
    onSeePlans: fn(),
    onSetUp: fn(),
  },
  argTypes: {
    onOpenChange: { control: false },
    onUpgrade: { control: false },
    onSeePlans: { control: false },
    onSetUp: { control: false },
  },
} satisfies Meta<typeof AssistantEmailIntroModal>;
export default meta;
type Story = StoryObj<typeof meta>;

/** The design: a Free plan is pitched the upgrade. */
export const AssistantEmailLocked: Story = {};

/** A plan with email, and an assistant with no address yet: the way into setup. */
export const AssistantEmailEntitled: Story = {
  args: { locked: false },
};

/** No name yet: the copy says "your assistant". */
export const AssistantEmailUnnamed: Story = {
  args: { assistantName: "" },
};

/**
 * The bare frame, for the next feature that needs an intro: give it a hero,
 * a title, a line, and whatever the pitch is.
 */
export const Frame: Story = {
  parameters: { controls: { disable: true } },
  render: (args) => (
    <FeatureIntroModal
      open={args.open}
      onOpenChange={args.onOpenChange}
      hero={
        <span aria-hidden="true" style={{ fontSize: "64px", lineHeight: 1 }}>
          ✨
        </span>
      }
      title="A new thing"
      description="One line on what it is, and why the reader might care."
    >
      <p className="text-body-small-default text-[var(--content-secondary)]">
        The feature's own pitch goes here.
      </p>
    </FeatureIntroModal>
  ),
};
