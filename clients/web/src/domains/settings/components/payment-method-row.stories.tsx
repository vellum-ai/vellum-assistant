/**
 * One saved card in Settings > Billing > Payment Methods.
 * `PaymentMethodsCard` owns the query and renders a row per card; the row
 * itself is pure props, so these stories drive it directly.
 *
 * The backend enforces a single payment method, so the row's only action is
 * Replace card, which swaps the card on file through the same setup flow used
 * to add one.
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
  },
} satisfies Meta<typeof PaymentMethodRow>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The default row: the brand named through `brandDisplayLabel` (the raw
 * `"visa"` reads as "Visa"), the last four digits, and the Replace card
 * action.
 */
export const Default: Story = {};

/**
 * The platform knows the card's expiry, so it trails the last four digits in
 * the same `MM / YY` form the modal's replace subtitle uses.
 */
export const WithExpiry: Story = {
  args: { expMonth: 4, expYear: 2042 },
};
