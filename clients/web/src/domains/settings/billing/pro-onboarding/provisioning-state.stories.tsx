/**
 * Every phase of the post-checkout provisioning takeover, the full-bleed screen
 * `BillingOnboardingModal` opens on while the platform rolls the purchased
 * machine and storage out.
 *
 * `ProvisioningState` is pure props, so each story names a phase and the data
 * that phase reads. `phaseMinMs={0}` disables the per-phase hold so the
 * requested `state` paints immediately instead of waiting out the floor the app
 * uses to keep a fast upgrade from flashing.
 *
 * The decorators supply what the modal supplies: the plan catalog and avatar
 * reads in a story-local query cache, and the takeover frame (a black ground, a
 * viewport-tall box, `data-theme="dark"`, and the `--takeover-surface` custom
 * property). The frame is reproduced in flow rather than mounted through
 * `Modal.Content`, whose overlay is `fixed`: one portaled overlay per story
 * would stack every story in this file on top of the others in the shared docs
 * iframe.
 *
 * The catalog fixture mirrors the platform's real Pro catalog (Mighty on
 * `credits_25`, Super on `credits_45`), so the credits chip quotes the amounts
 * a subscriber is actually billed.
 */
import type { Meta, StoryObj } from "@storybook/react-vite";

import type { ProvisioningDimensions } from "./provisioning-machine";
import { ProvisioningState } from "./provisioning-state";
import {
  CUSTOM_INTENT_THREE_ITEMS,
  CUSTOM_INTENT_TWO_ITEMS,
  NOTHING_TO_PROVISION,
  PACKAGE_INTENT,
  PHOTO_ASSISTANT_ID,
  TAKEOVER_BASE_ARGS,
  takeoverFrameDecorator,
  takeoverQueryDecorator,
  UNRESOLVED_ASSISTANT_ID,
} from "./takeover-story-support";

/** A base-plan assistant: the small machine on the smallest volume. */
const BASE_SNAPSHOT: ProvisioningDimensions = {
  machineSize: "small",
  storageGib: 30,
};

/** What a large-machine checkout buys. */
const LARGE_TARGETS: ProvisioningDimensions = {
  machineSize: "large",
  storageGib: 100,
};

/** Long enough that a terminal story stays on screen for as long as it is open. */
const STORY_DWELL_MS = 60 * 60 * 1000;

const meta: Meta<typeof ProvisioningState> = {
  title: "Settings/Billing/ProOnboarding/ProvisioningState",
  component: ProvisioningState,
  parameters: {
    layout: "fullscreen",
  },
  args: {
    ...TAKEOVER_BASE_ARGS,
    state: "CONFIRMING",
  },
  // Storybook applies decorators innermost first, so the frame renders inside
  // the query provider and reads the same avatar cache the takeover does.
  decorators: [takeoverFrameDecorator, takeoverQueryDecorator],
};

export default meta;
type Story = StoryObj<typeof ProvisioningState>;

/** Waiting on Stripe after a package checkout: the package names itself. */
export const ConfirmingPackageIntent: Story = {
  name: "Confirming · package intent (Mighty)",
  args: {
    state: "CONFIRMING",
    intent: PACKAGE_INTENT,
  },
};

/**
 * A custom checkout with two items. The chips are target-only: no actuals have
 * been read yet, so there is no current value to point an arrow away from.
 */
export const ConfirmingCustomIntentTwoItems: Story = {
  name: "Confirming · custom intent, 2 items",
  args: {
    state: "CONFIRMING",
    intent: CUSTOM_INTENT_TWO_ITEMS,
  },
};

/**
 * The same phase with all three items picked. Three chips do not fit the row's
 * default cap, so the row widens, and the bundle reads as its credit count.
 */
export const ConfirmingCustomIntentThreeItems: Story = {
  name: "Confirming · custom intent, 3 items",
  args: {
    state: "CONFIRMING",
    intent: CUSTOM_INTENT_THREE_ITEMS,
  },
};

/**
 * An in-place plan change confirming instead of a checkout: no stashed intent
 * to draw chips from, and the copy drops the word "upgrade".
 */
export const ConfirmingPlanChange: Story = {
  name: "Confirming · plan change",
  args: {
    state: "CONFIRMING",
    direction: "downgrade",
  },
};

/** The rollout itself: both dimensions are still moving, so both chips spin. */
export const WaitingMachineAndStorage: Story = {
  name: "Waiting · machine + storage",
  args: {
    state: "WAITING",
    targets: LARGE_TARGETS,
    fromSnapshot: BASE_SNAPSHOT,
  },
};

/**
 * The same wait after a package checkout, so the row carries a third chip.
 * Credits apply the moment the subscription is accepted, with nothing to roll
 * out, so that chip is checked while machine and storage are still spinning.
 */
export const WaitingThreeChips: Story = {
  name: "Waiting · three chips (package checkout)",
  args: {
    state: "WAITING",
    intent: PACKAGE_INTENT,
    targets: LARGE_TARGETS,
    fromSnapshot: BASE_SNAPSHOT,
  },
};

/** Past the 30s grace period: the caption concedes the wait and the creature settles. */
export const WaitingSoftWaiting: Story = {
  name: "Waiting · soft waiting",
  args: {
    state: "WAITING",
    softWaiting: true,
    targets: LARGE_TARGETS,
    fromSnapshot: BASE_SNAPSHOT,
  },
};

/**
 * A storage-only purchase. The machine target is null, so no machine chip is
 * drawn: a row for a pod that stays exactly where it is would assert a resize
 * that never runs.
 */
export const WaitingStorageOnly: Story = {
  name: "Waiting · storage only",
  args: {
    state: "WAITING",
    targets: { machineSize: null, storageGib: 100 },
    fromSnapshot: BASE_SNAPSHOT,
  },
};

/**
 * Super down to Mighty. Mighty names no machine tier, so the display-only
 * `machineFloor` supplies the size the server settles the pod at and the
 * machine chip still reads Medium to Small. Storage never shrinks, so the
 * lowered volume gets no chip at all, and the bundle steps down with it.
 */
export const WaitingMachineFloorDownsize: Story = {
  name: "Waiting · machine floor downsize",
  args: {
    state: "WAITING",
    direction: "downgrade",
    targets: { machineSize: null, storageGib: 10 },
    fromSnapshot: { machineSize: "medium", storageGib: 30 },
    machineFloor: "small",
    creditsChange: { fromTier: "credits_45", toTier: "credits_25" },
  },
};

/** Storage has landed and reports its green check while the machine still rolls. */
export const WaitingPartiallyLanded: Story = {
  name: "Waiting · partially landed",
  args: {
    state: "WAITING",
    targets: LARGE_TARGETS,
    fromSnapshot: BASE_SNAPSHOT,
    landed: { machine: false, storage: true },
  },
};

/**
 * A freshly hatched assistant, whose actuals have never been read. Both chips
 * drop their from-side and state only where they are headed.
 */
export const WaitingFreshHatch: Story = {
  name: "Waiting · fresh hatch, no from-side",
  args: {
    state: "WAITING",
    targets: LARGE_TARGETS,
    fromSnapshot: NOTHING_TO_PROVISION,
  },
};

/** Far enough into the wait that the background escape hatch is offered. */
export const WaitingEscapeAvailable: Story = {
  name: "Waiting · escape available",
  args: {
    state: "WAITING",
    targets: LARGE_TARGETS,
    fromSnapshot: BASE_SNAPSHOT,
    escapeAvailable: true,
  },
};

/**
 * Mighty up to Super as an in-place resize rather than a checkout: the credit
 * move is threaded through `creditsChange` instead of a stashed intent, so a
 * stale checkout stash can't leak into it.
 */
export const WaitingResizeUpgrade: Story = {
  name: "Waiting · in-place upgrade (Mighty to Super)",
  args: {
    state: "WAITING",
    direction: "upgrade",
    targets: { machineSize: "medium", storageGib: 30 },
    fromSnapshot: { machineSize: "small", storageGib: 10 },
    creditsChange: { fromTier: "credits_25", toTier: "credits_45" },
  },
};

/**
 * The resize is confirmed in flight. RESIZING and WAITING render identical
 * copy and share an animation key, so the swap between them is invisible: the
 * distinction only matters to the state machine.
 */
export const Resizing: Story = {
  name: "Resizing",
  args: {
    state: "RESIZING",
    targets: LARGE_TARGETS,
    fromSnapshot: BASE_SNAPSHOT,
  },
};

/**
 * Everything landed. Every chip carries its check, the creature stands at its
 * grown size, and no control is offered: the wizard advances on its own once
 * the dwell elapses.
 */
export const DoneMachineAndStorage: Story = {
  name: "Done · machine + storage",
  args: {
    state: "DONE",
    targets: LARGE_TARGETS,
    fromSnapshot: BASE_SNAPSHOT,
    celebrating: true,
    dwellMs: STORY_DWELL_MS,
  },
};

/** The same finish with the bundle the plan change added. */
export const DoneWithCredits: Story = {
  name: "Done · with credits",
  args: {
    state: "DONE",
    targets: LARGE_TARGETS,
    fromSnapshot: BASE_SNAPSHOT,
    creditsChange: { fromTier: null, toTier: "credits_25" },
    celebrating: true,
    dwellMs: STORY_DWELL_MS,
  },
};

/**
 * A credit-only switch: the machine and the volume both stay put, so the credit
 * move is the takeover's one statement of what changed.
 */
export const NotApplicableCreditOnly: Story = {
  name: "Not applicable · credit-only switch",
  args: {
    state: "NOT_APPLICABLE",
    direction: "change",
    targets: { machineSize: "large", storageGib: 50 },
    fromSnapshot: { machineSize: "large", storageGib: 50 },
    creditsChange: { fromTier: "credits_25", toTier: "credits_115" },
    celebrating: true,
    dwellMs: STORY_DWELL_MS,
  },
};

/** Nothing was owed and no bundle moved, so the phase is heading alone. */
export const NotApplicableNothingToShow: Story = {
  name: "Not applicable · nothing to show",
  args: {
    state: "NOT_APPLICABLE",
    direction: "change",
    targets: { machineSize: "large", storageGib: 50 },
    fromSnapshot: { machineSize: "large", storageGib: 50 },
    celebrating: true,
    dwellMs: STORY_DWELL_MS,
  },
};

/** Dropping the bundle entirely: the to-side is the explicit no-credits choice. */
export const NotApplicableDroppedBundle: Story = {
  name: "Not applicable · dropped bundle",
  args: {
    state: "NOT_APPLICABLE",
    direction: "change",
    targets: { machineSize: "large", storageGib: 50 },
    fromSnapshot: { machineSize: "large", storageGib: 50 },
    creditsChange: { fromTier: "credits_115", toTier: null },
    celebrating: true,
    dwellMs: STORY_DWELL_MS,
  },
};

/**
 * The stall clock ran out with no captured failure, so the wait is just slow.
 * The copy says so plainly rather than escalating, and the creature stops
 * straining: motion that promises progress under copy conceding none is worse
 * than stillness.
 */
export const StalledHonestWait: Story = {
  name: "Stalled · honest wait",
  args: {
    state: "STALLED",
    targets: LARGE_TARGETS,
    fromSnapshot: BASE_SNAPSHOT,
    escapeAvailable: true,
  },
};

/** A real reconcile failure: the snag heading, the mapped message, and a retry. */
export const StalledSnagSubmissionFailed: Story = {
  name: "Stalled · snag (submission failed)",
  args: {
    state: "STALLED",
    targets: LARGE_TARGETS,
    fromSnapshot: BASE_SNAPSHOT,
    escapeAvailable: true,
    kickError: { error: "provisioning_submission_failed" },
  },
};

/** The reconcile could not see the Pro entitlement yet. */
export const StalledSnagNoActivePro: Story = {
  name: "Stalled · snag (no active pro)",
  args: {
    state: "STALLED",
    targets: LARGE_TARGETS,
    fromSnapshot: BASE_SNAPSHOT,
    escapeAvailable: true,
    kickError: { error: "no_active_pro" },
  },
};

/** No mapped code, so the server's own `detail` carries the caption. */
export const StalledSnagRawDetail: Story = {
  name: "Stalled · snag (raw detail)",
  args: {
    state: "STALLED",
    targets: LARGE_TARGETS,
    fromSnapshot: BASE_SNAPSHOT,
    escapeAvailable: true,
    kickError: { detail: "Resize already in progress." },
  },
};

/**
 * A failure with nothing readable in it, on a plan change. The caption falls
 * back to the direction's own wording, so a stalled downgrade never offers to
 * keep working on "your upgrade".
 */
export const StalledSnagPlanChange: Story = {
  name: "Stalled · snag (plan change)",
  args: {
    state: "STALLED",
    direction: "downgrade",
    targets: LARGE_TARGETS,
    fromSnapshot: BASE_SNAPSHOT,
    escapeAvailable: true,
    kickError: {},
  },
};

/**
 * The subscription read never caught up. This is the one phase with two
 * buttons: the change is safe either way, so the user picks between waiting it
 * out again and leaving for billing.
 */
export const ConfirmTimeoutUpgrade: Story = {
  name: "Confirm timeout · upgrade",
  args: {
    state: "CONFIRM_TIMEOUT",
  },
};

/** The same timeout on a plan change, which names no payment. */
export const ConfirmTimeoutPlanChange: Story = {
  name: "Confirm timeout · plan change",
  args: {
    state: "CONFIRM_TIMEOUT",
    direction: "downgrade",
  },
};

/**
 * An assistant with an uploaded avatar. There is no character color to tint
 * from, so the surface stays on its neutral ground and the image itself is
 * blurred behind the content to carry the colour.
 */
export const CustomImageAvatarBackdrop: Story = {
  name: "Waiting · custom-image avatar",
  args: {
    state: "WAITING",
    targets: LARGE_TARGETS,
    fromSnapshot: BASE_SNAPSHOT,
    assistantId: PHOTO_ASSISTANT_ID,
  },
};

/**
 * An assistant nothing was seeded for. The takeover withholds the creature
 * until the read settles, holding the reserved stage empty on the neutral
 * ground; once it settles with nothing, the neutral bundled creature stands in.
 * Storybook has no daemon, so the settle here is a failed fetch rather than an
 * empty answer, which is the same outcome the takeover sees when the machine
 * it is drawing is the one being restarted.
 */
export const UnresolvedAvatar: Story = {
  name: "Waiting · unresolved avatar",
  args: {
    state: "WAITING",
    targets: LARGE_TARGETS,
    fromSnapshot: BASE_SNAPSHOT,
    assistantId: UNRESOLVED_ASSISTANT_ID,
  },
};
