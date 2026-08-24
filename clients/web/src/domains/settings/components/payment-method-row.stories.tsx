/**
 * One saved card in Settings > Billing > Payment Methods.
 * `PaymentMethodsCard` owns the query and renders a row per card; the row
 * itself is pure props, so these stories drive it directly.
 *
 * The backend enforces a single payment method, so the row's only action is
 * Update Card, which replaces the card on file through the same setup flow
 * used to add one.
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
 * The default row: the brand run through `brandLabel` so the raw Stripe string
 * reads as "Visa", the last four digits, and the Update Card action.
 */
export const Default: Story = {};
