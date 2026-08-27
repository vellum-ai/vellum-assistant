/**
 * The post-checkout provisioning takeover: the full-bleed screen
 * `BillingOnboardingModal` opens on while the platform rolls the purchased
 * machine and storage out.
 *
 * `ProvisioningState` is pure props, so one playground reaches every state it
 * can render. `Playground` exposes the whole surface through the Controls
 * panel; the other stories are entry points into the same render, each one only
 * a preset set of args.
 *
 * How to drive it: `phase` picks the provisioning state. `change` picks the plan
 * move whose chips are drawn. `snag` supplies the captured reconcile failure
 * STALLED reads, and `avatar` swaps the seeded assistant between a bundled
 * creature, an uploaded image, and one nothing was seeded for. `landedMachine`,
 * `landedStorage`, `softWaiting`, and `escapeAvailable` drive the wait's own
 * progress and affordances, and `obscureCredits` flips the feature flag that
 * replaces every credit amount with its bundle name. Each is a URL arg too, so
 * a state links directly: `?args=phase:STALLED;snag:submissionFailed`.
 *
 * The decorators supply what the modal supplies: the plan catalog and avatar
 * reads in a story-local query cache, and the takeover frame (a black ground, a
 * viewport-tall box, `data-theme="dark"`, and the `--takeover-surface` custom
 * property). The frame is reproduced in flow rather than mounted through
 * `Modal.Content`, whose overlay is `fixed`: one portaled overlay per story
 * would stack every story in this file on top of the others in the shared docs
 * iframe.
 */
import type { Meta, StoryObj } from "@storybook/react-vite";

import type { ProvisioningStateKind } from "./provisioning-machine";
import { ProvisioningState } from "./provisioning-state";
import {
  obscureCreditsDecorator,
  TAKEOVER_AVATARS,
  TAKEOVER_CONSTANT_PROPS,
  TAKEOVER_SCENARIOS,
  TAKEOVER_SNAGS,
  takeoverFrameDecorator,
  takeoverQueryDecorator,
  type TakeoverAvatarKey,
  type TakeoverScenario,
  type TakeoverScenarioKey,
  type TakeoverSnagKey,
} from "./takeover-story-support";

/**
 * The playground's controls, which are not `ProvisioningState` props: each one
 * either names a row in a fixture table the render expands, or drives something
 * outside the component entirely (`obscureCredits` is a feature flag).
 *
 * The three table-backed controls hold the row's name rather than the row, and
 * the render looks it up. That keeps a story's `args` type-checked against the
 * options it may name, which an `argTypes` `mapping` cannot do, and it is the
 * name that reads well in a URL arg.
 *
 * Each control is described in the `argTypes` below, which is where the docs
 * page and the Controls panel read a description from: nothing extracts one
 * from this interface, because the meta names no component to derive docgen
 * from.
 */
interface TakeoverPlaygroundArgs {
  phase: ProvisioningStateKind;
  change: TakeoverScenarioKey;
  landedMachine: boolean;
  landedStorage: boolean;
  softWaiting: boolean;
  escapeAvailable: boolean;
  snag: TakeoverSnagKey;
  avatar: TakeoverAvatarKey;
  obscureCredits: boolean;
}

const PHASES: ProvisioningStateKind[] = [
  "CONFIRMING",
  "CONFIRM_TIMEOUT",
  "WAITING",
  "RESIZING",
  "DONE",
  "NOT_APPLICABLE",
  "STALLED",
];

function renderTakeover(args: TakeoverPlaygroundArgs) {
  // Annotated so the props a scenario may omit are still readable off the row.
  const scenario: TakeoverScenario = TAKEOVER_SCENARIOS[args.change];
  return (
    <ProvisioningState
      {...TAKEOVER_CONSTANT_PROPS}
      state={args.phase}
      direction={scenario.direction}
      intent={scenario.intent}
      creditsChange={scenario.creditsChange}
      targets={scenario.targets}
      fromSnapshot={scenario.fromSnapshot}
      machineFloor={scenario.machineFloor}
      landed={{ machine: args.landedMachine, storage: args.landedStorage }}
      softWaiting={args.softWaiting}
      escapeAvailable={args.escapeAvailable}
      kickError={TAKEOVER_SNAGS[args.snag]}
      assistantId={TAKEOVER_AVATARS[args.avatar]}
    />
  );
}

const meta: Meta<TakeoverPlaygroundArgs> = {
  title: "Settings/Billing/ProOnboarding/ProvisioningState",
  parameters: {
    layout: "fullscreen",
  },
  argTypes: {
    phase: {
      description: "Which provisioning state to render.",
      control: "select",
      options: PHASES,
    },
    change: {
      description: "Which plan move the resource chips describe.",
      control: "select",
      options: Object.keys(TAKEOVER_SCENARIOS),
    },
    snag: {
      description:
        "The ensure-provisioned failure STALLED words its heading and caption from. `none` is the wait that simply ran long.",
      control: "select",
      options: Object.keys(TAKEOVER_SNAGS),
    },
    avatar: {
      description: "Which seeded assistant the takeover draws.",
      control: "radio",
      options: Object.keys(TAKEOVER_AVATARS),
    },
    landedMachine: {
      description: "The machine has finished rolling out, so its chip checks.",
      control: "boolean",
    },
    landedStorage: {
      description: "The volume has finished resizing, so its chip checks.",
      control: "boolean",
    },
    softWaiting: {
      description: "Past the grace window, where the copy concedes the wait.",
      control: "boolean",
    },
    escapeAvailable: {
      description: "Offer the background escape hatch.",
      control: "boolean",
    },
    obscureCredits: {
      description:
        "Flip `obscure-credits`, which states bundles by catalog name instead of by monthly rate. Live only on `Playground`.",
      // Hidden everywhere but `Playground`: the flag is a module-level singleton,
      // and the docs page mounts every curated story into one iframe, so a
      // control there would flip the treatment for all of them at once.
      control: false,
    },
  },
  args: {
    phase: "WAITING",
    change: "baseToSuper",
    landedMachine: false,
    landedStorage: false,
    softWaiting: false,
    escapeAvailable: false,
    snag: "none",
    avatar: "creature",
    obscureCredits: false,
  },
  render: renderTakeover,
  // Storybook applies decorators innermost first, so the flag is already set for
  // the frame and the takeover, both of which sit inside the query provider that
  // answers their reads.
  decorators: [
    takeoverFrameDecorator,
    obscureCreditsDecorator,
    takeoverQueryDecorator,
  ],
};

export default meta;
type Story = StoryObj<TakeoverPlaygroundArgs>;

// Every curated story below pins `obscureCredits: false` and exposes no control
// for it. The flag is a module-level Zustand singleton and the docs page mounts
// all of these into one iframe at once, so a story that flipped it would flip it
// for its neighbours too, and their decorators would not re-run to undo it. The
// flag-on treatment belongs to `Playground`, which carries the only live control
// and stays off the docs page so it is never mounted beside them.

/**
 * The whole surface, driven from the Controls panel. Opens on the rollout of a
 * base-to-Super upgrade: both dimensions are still moving, so both chips spin,
 * and the bundle applied the moment the subscription was accepted, so its chip
 * is already checked.
 */
export const Playground: Story = {
  tags: ["!autodocs"],
  argTypes: {
    obscureCredits: { control: "boolean" },
  },
};

/** Waiting on Stripe after a package checkout: the package names itself. */
export const Confirming: Story = {
  args: {
    phase: "CONFIRMING",
    change: "packageIntent",
    obscureCredits: false,
  },
};

/**
 * The subscription read never caught up. This is the one phase with two
 * buttons: the change is safe either way, so the user picks between waiting it
 * out again and leaving for billing.
 */
export const ConfirmTimeout: Story = {
  args: {
    phase: "CONFIRM_TIMEOUT",
    obscureCredits: false,
  },
};

/**
 * The rollout itself, which is also the playground's opening state: every
 * applicable change is on screen from the first frame, each carrying its own
 * progress.
 */
export const Waiting: Story = {
  args: {
    phase: "WAITING",
    change: "baseToSuper",
    obscureCredits: false,
  },
};

/**
 * Everything landed. Every chip carries its check, the creature stands at its
 * grown size, and no control is offered: the wizard advances on its own once
 * the dwell elapses.
 */
export const Done: Story = {
  args: {
    phase: "DONE",
    obscureCredits: false,
  },
};

/**
 * A change that owed no provisioning at all. A credit-only switch leaves the
 * machine and the volume where they are, so the credit move is the takeover's
 * one statement of what changed.
 */
export const NotApplicable: Story = {
  args: {
    phase: "NOT_APPLICABLE",
    change: "creditOnlySwitch",
    obscureCredits: false,
  },
};

/**
 * A real reconcile failure: the snag heading, the mapped message, and a
 * retry-flavoured escape. Clear `snag` for the other half of this phase, the
 * wait that simply ran long and says so plainly.
 */
export const Stalled: Story = {
  args: {
    phase: "STALLED",
    snag: "submissionFailed",
    escapeAvailable: true,
    obscureCredits: false,
  },
};
