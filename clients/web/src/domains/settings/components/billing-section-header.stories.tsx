/**
 * Shared header for the billing settings sections (Payment Methods, Credits,
 * Invoices). The stories mirror the three production call sites: title only,
 * title + subtitle, and the full form with an actions cluster.
 */
import type { Meta, StoryObj } from "@storybook/react-vite";
import { Coins } from "lucide-react";

import { Button } from "@vellumai/design-library/components/button";

import { BillingSectionHeader } from "@/domains/settings/components/billing-section-header";

const meta = {
  title: "Settings/Billing/BillingSectionHeader",
  component: BillingSectionHeader,
  parameters: { layout: "padded" },
} satisfies Meta<typeof BillingSectionHeader>;

export default meta;

type Story = StoryObj<typeof meta>;

export const TitleOnly: Story = {
  args: { title: "Invoices" },
};

export const WithSubtitle: Story = {
  args: {
    title: "Payment Methods",
    subtitle: "Payment methods linked to your account.",
  },
};

export const WithActions: Story = {
  args: {
    title: "Credits",
    subtitle: "Quick overview of your balances and other things",
    actions: (
      <>
        <Button
          variant="outlined"
          leftIcon={<Coins className="h-4 w-4" aria-hidden />}
        >
          Earn Free Credits
        </Button>
        <Button variant="primary">Add Credits</Button>
      </>
    ),
  },
};
