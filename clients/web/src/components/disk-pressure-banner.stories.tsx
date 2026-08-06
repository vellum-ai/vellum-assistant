/**
 * The storage wall. Three escalating modes, and (the part worth cataloging)
 * an **Upgrade** CTA that appears only when the assistant actually has an
 * upgrade path.
 *
 * Both mount points gate that CTA themselves and pass `onUpgradeStorage: null`
 * when there is nowhere to upgrade to:
 *
 *   - chat: `assistantStateKind === "active" && !isNativeAndroid`
 *     (`disk-pressure-banner-slot.tsx:125`)
 *   - settings: `infraGate === "full" && !isNativeAndroid`
 *     (`general-page.tsx:149`)
 *
 * The settings mount also omits `onDismissWarning`, so it has no dismiss X and
 * no "Don't show again" checkbox. Both variants are storied below.
 */
import type { Meta, StoryObj } from "@storybook/react-vite";
import { userEvent, within } from "storybook/test";

import type { DiskPressureStatus } from "@vellumai/assistant-api";

import { DiskPressureBanner } from "@/components/disk-pressure-banner";

function makeStatus(
  overrides: Partial<DiskPressureStatus> = {},
): DiskPressureStatus {
  return {
    enabled: true,
    state: "warning",
    locked: false,
    acknowledged: false,
    overrideActive: false,
    effectivelyLocked: false,
    lockId: null,
    usagePercent: 86,
    thresholdPercent: 85,
    path: "/workspace",
    lastCheckedAt: "2026-08-04T12:00:00Z",
    blockedCapabilities: [],
    error: null,
    ...overrides,
  };
}

const meta: Meta<typeof DiskPressureBanner> = {
  title: "Upsell Walls/Storage Wall",
  component: DiskPressureBanner,
  parameters: { layout: "padded" },
  argTypes: {
    mode: {
      control: "select",
      options: ["warning", "cleanup", "acknowledgement-required"],
    },
  },
  args: {
    status: makeStatus(),
    mode: "warning",
    onAcknowledge: () => {},
    onDismissWarning: () => {},
    onReviewWorkspaceData: () => {},
    onUpgradeStorage: () => {},
  },
  decorators: [
    (Story) => (
      <div className="mx-auto w-full max-w-[720px]">
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof DiskPressureBanner>;

/**
 * The chat mount on a platform-hosted assistant: **Manage Storage** to free
 * space, **Upgrade** to buy more, plus the dismiss affordances.
 */
export const WarningWithUpgrade: Story = {
  name: "Warning · Manage Storage + Upgrade",
};

/**
 * Self-hosted, or native Android (consumption-only). With
 * `onUpgradeStorage: null` the Upgrade button disappears **and the body copy
 * drops "or add more storage"**. The wall stops advertising a purchase it
 * cannot complete.
 */
export const WarningWithoutUpgrade: Story = {
  name: "Warning · no upgrade path (self-hosted / Android)",
  args: { onUpgradeStorage: null },
};

/**
 * The settings mount (`general-page.tsx`) passes no `onDismissWarning`, so the
 * banner is not dismissible and the "Don't show again" checkbox is gone.
 */
export const WarningNotDismissible: Story = {
  name: "Warning · settings mount (not dismissible)",
  args: { onDismissWarning: undefined },
};

/** Usage is unknown when the assistant reports a null percentage. */
export const WarningUnknownUsage: Story = {
  name: "Warning · unknown usage",
  args: { status: makeStatus({ usagePercent: null }) },
};

/**
 * Cleanup mode: the assistant is actively freeing space. Same two CTAs, but no
 * dismiss and no checkbox: the user cannot opt out of this one.
 */
export const Cleanup: Story = {
  args: {
    mode: "cleanup",
    status: makeStatus({ state: "warning", usagePercent: 94 }),
  },
};

/**
 * Critical: the banner turns `tone="error"` and collapses to a single
 * **Review** button. There is deliberately no inline Upgrade here, because the
 * upgrade path lives inside the acknowledgement modal.
 */
export const CriticalAcknowledgementRequired: Story = {
  name: "Critical · Review (opens modal)",
  args: {
    mode: "acknowledgement-required",
    status: makeStatus({ state: "critical", usagePercent: 99 }),
  },
};

/**
 * Critical with a failed acknowledgement. The error renders inline above the
 * Review button as an alert.
 */
export const CriticalWithAcknowledgeError: Story = {
  name: "Critical · acknowledge failed",
  args: {
    mode: "acknowledgement-required",
    status: makeStatus({ state: "critical", usagePercent: 99 }),
    acknowledgeError: "Could not acknowledge. Please try again.",
  },
};

/**
 * The acknowledgement modal is where the critical-state **Upgrade** CTA
 * actually lives, beside **Acknowledge**. The interaction below opens it on
 * the canvas; on this docs page play functions do not run, so open the canvas
 * (or click **Review**) to see it.
 */
export const CriticalModalUpgradeCta: Story = {
  name: "Critical · modal holds the Upgrade CTA",
  args: {
    mode: "acknowledgement-required",
    status: makeStatus({ state: "critical", usagePercent: 99 }),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Review" }));
  },
};
