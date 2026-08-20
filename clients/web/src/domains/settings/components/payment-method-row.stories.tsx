/**
 * One saved card in Settings > Billing > Payment Methods.
 * `PaymentMethodsCard` owns the query and renders a row per card; the row
 * itself is pure props, so these stories drive it directly.
 *
 * `showRemove` and `borderlessRemove` are how the `obscure-credits` flag
 * reaches this surface. `showsRemove()` in `payment-methods-card.tsx` drops the
 * button for an org holding a single card, so the only way to pay cannot be
 * removed from here; a second card brings it back, and it is always present
 * with the flag off. `borderlessRemove` is the flag's presentation: plain red
 * text where the flag-off row draws an outlined button.
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
    borderlessRemove: false,
  },
} satisfies Meta<typeof PaymentMethodRow>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The default row with the flag off: the brand run through `brandLabel` so the
 * raw Stripe string reads as "Visa", the last four digits, and both actions,
 * Remove among them as an outlined button.
 */
export const Default: Story = {};

/**
 * The flag-on presentation, which an org holding more than one card reaches:
 * Remove is plain red text with no border around it, so the row carries one
 * outlined control rather than two competing ones.
 */
export const BorderlessRemove: Story = {
  name: "Borderless Remove",
  args: { borderlessRemove: true },
};

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
