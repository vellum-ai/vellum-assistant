/**
 * The payment-method modal chrome in each of its states.
 *
 * The real modal mounts Stripe Elements as `children`, and those iframes
 * cannot load in Storybook, so the stories pass grey blocks the same height as
 * the Stripe inputs. That keeps the header, card-on-file row, state slot, and
 * footer laid out at the real proportions while the shell stays reviewable
 * without a publishable key.
 *
 * Light, dark, and velvet all come from the theme toolbar, so there is no
 * per-theme story.
 */
import type { Meta, StoryObj } from "@storybook/react-vite";

import { PaymentMethodModalShell } from "@/domains/settings/components/payment-method-modal-shell";

function FieldPlaceholders() {
  return (
    <>
      <div className="h-[42px] rounded-lg bg-[var(--surface-base)]" />
      <div className="h-[42px] rounded-lg bg-[var(--surface-base)]" />
      <div className="grid grid-cols-2 gap-[10px]">
        <div className="h-[42px] rounded-lg bg-[var(--surface-base)]" />
        <div className="h-[42px] rounded-lg bg-[var(--surface-base)]" />
      </div>
      <div className="h-[42px] rounded-lg bg-[var(--surface-base)]" />
    </>
  );
}

const meta = {
  title: "Settings/Billing/PaymentMethodModalShell",
  component: PaymentMethodModalShell,
  parameters: { layout: "centered" },
  args: {
    open: true,
    mode: "add",
    state: "idle",
    showTerms: true,
    onClose: () => {},
    onSubmit: () => {},
    children: <FieldPlaceholders />,
  },
} satisfies Meta<typeof PaymentMethodModalShell>;

export default meta;
type Story = StoryObj<typeof meta>;

/** First card: no card on file, so the header reads "Add a card". */
export const AddIdle: Story = {};

/** A card already on file, shown above the fields with its expiry. */
export const ReplaceIdle: Story = {
  args: {
    mode: "replace",
    cardOnFile: { brand: "visa", last4: "4242", expMonth: 4, expYear: 2042 },
  },
};

/** `confirmSetup` is in flight: fields dimmed, every dismissal locked out. */
export const Submitting: Story = {
  args: { state: "submitting" },
};

/** The save stayed pending long enough to read as a 3DS challenge. */
export const RequiresAction: Story = {
  args: { state: "requires_action" },
};

/** A declined card: the message sits under the fields, the form stays usable. */
export const Declined: Story = {
  args: {
    state: "error",
    errorMessage: "Your bank declined this card. Try another, or contact them.",
  },
};

/** The card saved and the refreshed config has auto-reload enabled. */
export const Saved: Story = {
  args: {
    state: "saved",
    savedCard: { brand: "visa", last4: "1881" },
    autoReloadActive: true,
  },
};

/** Saved without brand details, and auto-reload is still off. */
export const SavedGeneric: Story = {
  args: {
    state: "saved",
    savedCard: null,
    autoReloadActive: false,
  },
};

/** Replacing a card: once saved, the old card is gone rather than pending. */
export const SavedAfterReplace: Story = {
  args: {
    mode: "replace",
    cardOnFile: { brand: "visa", last4: "4242", expMonth: 4, expYear: 2042 },
    state: "saved",
    savedCard: { brand: "visa", last4: "1881" },
    autoReloadActive: true,
  },
};

/** A 3DS redirect return: no mode to title the modal, so the panel is it. */
export const SavedFromRedirect: Story = {
  args: {
    state: "saved",
    savedCard: { brand: "visa", last4: "1881" },
    autoReloadActive: true,
    headerless: true,
  },
};
