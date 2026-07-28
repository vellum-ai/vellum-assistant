import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { useLayoutEffect } from "react";

import { PackageSwitchConfirmModal } from "@/domains/settings/billing/plans/package-switch-confirm-modal";
import {
  makeProPackage,
  makeSuperPackage,
  makeUltraPackage,
} from "@/domains/settings/billing/plans/pro-package-test-fixtures";
import { avatarQueryKey } from "@/hooks/use-assistant-avatar";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { BUNDLED_COMPONENTS } from "@/utils/avatar-bundled-components";

const STORY_ASSISTANT_ID = "story-assistant";

// The header tile draws the assistant avatar through `useAssistantAvatar`,
// which has no daemon to fetch from here. Seeding the cache under both
// manifest-gate values renders the creature instead of an empty square.
const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, staleTime: Infinity } },
});
for (const supportsManifest of [false, true]) {
  queryClient.setQueryData(
    [...avatarQueryKey(STORY_ASSISTANT_ID), supportsManifest],
    { components: BUNDLED_COMPONENTS, traits: null, customImageUrl: null },
  );
}

const SUPER_PACKAGE = makeSuperPackage();

const meta: Meta<typeof PackageSwitchConfirmModal> = {
  title: "Settings/Billing/PackageSwitchConfirmModal",
  component: PackageSwitchConfirmModal,
  parameters: {
    layout: "centered",
  },
  argTypes: {
    relation: {
      control: "select",
      options: ["upgrade", "downgrade", "switch"],
    },
    pending: { control: "boolean" },
  },
  args: {
    open: true,
    pending: false,
    onCancel: () => {},
    onConfirm: () => {},
  },
  decorators: [
    (Story) => {
      // The avatar tile resolves its assistant from the active id, and holds an
      // empty square while that is null. Writing the store during render would
      // update the subscribed tile mid-render on every control change, and the
      // fake id would outlive these stories — so seed it in an effect and hand
      // the previous value back on unmount.
      useLayoutEffect(() => {
        const previous =
          useResolvedAssistantsStore.getState().activeAssistantId;
        useResolvedAssistantsStore.setState({
          activeAssistantId: STORY_ASSISTANT_ID,
        });
        return () => {
          useResolvedAssistantsStore.setState({
            activeAssistantId: previous,
          });
        };
      }, []);
      return (
        <QueryClientProvider client={queryClient}>
          <Story />
        </QueryClientProvider>
      );
    },
  ],
};

export default meta;
type Story = StoryObj<typeof PackageSwitchConfirmModal>;

/** Moving up the catalog: the prorated difference is charged today. */
export const Upgrade: Story = {
  args: {
    relation: "upgrade",
    packageName: "Mighty",
    targetPackage: makeProPackage(),
  },
};

/**
 * Moving down: the confirm turns destructive, names the target explicitly, and
 * the no-refund safeguard note sits below the checklist.
 */
export const Downgrade: Story = {
  args: {
    relation: "downgrade",
    packageName: "Mighty",
    targetPackage: makeProPackage(),
  },
};

/**
 * A Custom sub's tiers can diverge from any stock package, so the switch has no
 * knowable direction — neutral copy, non-destructive confirm. Super carries an
 * extra feature row, so the checklist runs to four.
 */
export const NeutralSwitch: Story = {
  args: {
    relation: "switch",
    packageName: "Super",
    targetPackage: SUPER_PACKAGE,
  },
};

/** A `change-package` call is in flight: both actions are disabled. */
export const Pending: Story = {
  args: {
    relation: "upgrade",
    packageName: "Super",
    targetPackage: SUPER_PACKAGE,
    pending: true,
  },
};

/**
 * No target package, so the body collapses to header + actions. Both call
 * sites gate `open` on a resolved target and derive `packageName` from it, so
 * the bare "Upgrade to" title this state produces stays off-screen.
 */
export const NoTargetPackage: Story = {
  args: {
    relation: "upgrade",
    packageName: "",
    targetPackage: null,
  },
};

/**
 * A name wider than the `size="sm"` card's title column wraps onto the second
 * line the header already allows, rather than ellipsizing. No such package
 * exists — it is Ultra on the 120 GB (`l`) storage tier, priced off the real
 * tier table, so only the name is invented.
 */
export const LongPackageName: Story = {
  args: {
    relation: "upgrade",
    packageName: "Ultra Enterprise Performance",
    targetPackage: makeUltraPackage({
      key: "ultra-enterprise",
      name: "Ultra Enterprise Performance",
      description:
        "Large machine, 120 GB of storage, and $115 in monthly credits.",
      storage_tier: "l",
      storage_gib: 120,
      storage_price_cents: 3000,
      total_price_cents: 21500,
    }),
  },
};
