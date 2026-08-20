/**
 * One saved card in Settings > Billing > Payment Methods.
 * `PaymentMethodsCard` owns the query and renders a row per card; the row
 * itself is pure props, so these stories drive it directly.
 *
 * `showRemove` is how the `obscure-credits` flag reaches this surface.
 * `showsRemove()` in `payment-methods-card.tsx` drops the button for an org
 * holding a single card, so the only way to pay cannot be removed from here; a
 * second card brings it back, and it is always present with the flag off.
 * Remove itself is plain red text in every state.
 */
import type { Meta, StoryObj } from "@storybook/react-vite";

import { PaymentMethodRow } from "@/domains/settings/components/payment-method-row";

const meta = {
  title: "Settings/Billing/PaymentMethodRow",
  component: PaymentMethodRow,
  parameters: { layout: "padded" },
  args: {
    brand: "visa",
    last4: "4242",
    onUpdateCard: () => {},
    onRemove: () => {},
    removing: false,
    showRemove: true,
  },
} satisfies Meta<typeof PaymentMethodRow>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The default row: the brand run through `brandLabel` so the raw Stripe string
 * reads as "Visa", the last four digits, and both actions. Remove is plain red
 * text with no border around it, so the row carries one outlined control rather
 * than two competing ones.
 */
export const Default: Story = {};

/**
 * `showRemove: false`, the single-card state under `obscure-credits`. Update
 * Card stays, so the user can still swap the card on file, just not leave the
 * org without one.
 */
export const WithoutRemove: Story = {
  name: "Without Remove",
  args: { showRemove: false },
};

/**
 * The removal mutation in flight. The button states what it is doing and goes
 * disabled, so a second click cannot fire it again.
 */
export const Removing: Story = {
  args: { removing: true },
};
