import type { Meta, StoryObj } from "@storybook/react-vite";
import { ChevronDown } from "lucide-react";
import { useState } from "react";
import { userEvent, within } from "storybook/test";

import { Collapsible } from "@vellumai/design-library/components/collapsible";
import { Typography } from "@vellumai/design-library/components/typography";

import type { SlackChannel } from "@/domains/channels/slack-channels-query";
import type { ChannelDefaultBucket } from "@/domains/channels/slack-channel-overrides";
import type { RiskThreshold } from "@/utils/threshold-presets";

import { SlackChannelList } from "./slack-channel-list";
import { SlackChannelTypeDefaults } from "./slack-channel-type-defaults";

type BucketTiers = Record<ChannelDefaultBucket, RiskThreshold | undefined>;

const NO_TIERS: BucketTiers = { channels: undefined, dm: undefined };

function makeChannel(
  overrides: Partial<SlackChannel> & Pick<SlackChannel, "id" | "name">,
): SlackChannel {
  return {
    type: "channel",
    isPrivate: false,
    isMember: true,
    memberCount: null,
    topic: null,
    imageUrl: null,
    ...overrides,
  };
}

const CHANNELS: SlackChannel[] = [
  makeChannel({ id: "C001", name: "general", memberCount: 42 }),
  makeChannel({ id: "C002", name: "engineering", memberCount: 18 }),
  makeChannel({ id: "C003", name: "eng-releases", memberCount: 9 }),
  makeChannel({ id: "C004", name: "design", memberCount: 7 }),
  makeChannel({ id: "C005", name: "leadership", isPrivate: true, memberCount: 4 }),
];

const meta: Meta<typeof SlackChannelTypeDefaults> = {
  title: "Channels/SlackChannelTypeDefaults",
  component: SlackChannelTypeDefaults,
  args: {
    assistantName: "Example Assistant",
    // Seeded global interactive threshold: Relaxed / medium.
    globalDefaultTier: "medium",
    loading: false,
    error: false,
    pendingBuckets: new Set<ChannelDefaultBucket>(),
  },
  decorators: [
    (Story) => (
      <div style={{ maxWidth: 720, margin: "2rem auto" }}>
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof SlackChannelTypeDefaults>;

/** Both buckets follow the global default → each reads "Relaxed · default". */
export const Default: Story = {
  render: function DefaultDefaults(args) {
    const [tiers, setTiers] = useState<BucketTiers>(NO_TIERS);
    return (
      <SlackChannelTypeDefaults
        {...args}
        bucketTiers={tiers}
        onBucketChange={(bucket, tier) =>
          setTiers((prev) => ({ ...prev, [bucket]: tier }))
        }
        onBucketReset={(bucket) =>
          setTiers((prev) => ({ ...prev, [bucket]: undefined }))
        }
      />
    );
  },
};

/**
 * DMs pinned tighter than channels: "Channels" follows the default (Relaxed),
 * "Direct messages" is set to Strict.
 */
export const Customized: Story = {
  render: function CustomizedDefaults(args) {
    const [tiers, setTiers] = useState<BucketTiers>({
      channels: undefined,
      dm: "none",
    });
    return (
      <SlackChannelTypeDefaults
        {...args}
        bucketTiers={tiers}
        onBucketChange={(bucket, tier) =>
          setTiers((prev) => ({ ...prev, [bucket]: tier }))
        }
        onBucketReset={(bucket) =>
          setTiers((prev) => ({ ...prev, [bucket]: undefined }))
        }
      />
    );
  },
};

/**
 * The full Slack sub-tab layout: the default-access card as the hero, with the
 * per-channel presence list folded into the "Individual channels" collapsible
 * below (collapsed by default). Mirrors `SlackChannelSection`.
 */
export const InContext: Story = {
  render: function SectionLayout(args) {
    const [tiers, setTiers] = useState<BucketTiers>(NO_TIERS);
    const channelsDefault = tiers.channels ?? args.globalDefaultTier;
    return (
      <div className="flex flex-col gap-4">
        <SlackChannelTypeDefaults
          {...args}
          bucketTiers={tiers}
          onBucketChange={(bucket, tier) =>
            setTiers((prev) => ({ ...prev, [bucket]: tier }))
          }
          onBucketReset={(bucket) =>
            setTiers((prev) => ({ ...prev, [bucket]: undefined }))
          }
        />
        <Collapsible.Root type="single" collapsible>
          <Collapsible.Item value="individual-channels">
            <Collapsible.Trigger className="group justify-between gap-2 px-1 py-2">
              <Typography as="span" variant="body-small-emphasised">
                Individual channels
              </Typography>
              <ChevronDown
                aria-hidden="true"
                className="h-4 w-4 shrink-0 text-[var(--content-tertiary)] transition-transform group-data-[state=open]:rotate-180"
              />
            </Collapsible.Trigger>
            <Collapsible.Content>
              <div className="pt-3">
                <SlackChannelList
                  assistantDisplayName="Example Assistant"
                  slackHandle="@example-assistant"
                  channels={CHANNELS}
                  defaultTier={channelsDefault}
                  showLegend={false}
                />
              </div>
            </Collapsible.Content>
          </Collapsible.Item>
        </Collapsible.Root>
      </div>
    );
  },
};

/** The "Individual channels" collapsible expanded, showing the per-channel rows. */
export const InContextExpanded: Story = {
  ...InContext,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      canvas.getByRole("button", { name: /individual channels/i }),
    );
  },
};
