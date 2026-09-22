/**
 * The Invoices section of the billing page: a card whose table sits behind a
 * Show Invoices toggle and lists each invoice's date, amount, status tag, and
 * view or download actions, with the first four rows shown and the rest
 * behind Show more. The rows come from an infinite query on the platform
 * client, so each story seeds that query's cache in its own client, and a
 * play step opens the section the way a user would. The stories cover a
 * populated list with every status Stripe reports and an account with no
 * invoices.
 */
import type { Meta, StoryObj } from "@storybook/react-vite";
import type { InfiniteData } from "@tanstack/react-query";
import { userEvent, within } from "storybook/test";

import { InvoicesTable } from "@/domains/settings/components/invoices-table";
import { organizationsBillingInvoicesRetrieveInfiniteQueryKey } from "@/generated/api/@tanstack/react-query.gen";
import type { Invoice, InvoiceListResponse } from "@/generated/api/types.gen";
import { withQueryCache } from "@/lib/story-query-cache";

function unixSeconds(year: number, monthIndex: number, day: number): number {
  return Date.UTC(year, monthIndex, day, 12) / 1000;
}

const INVOICES: Invoice[] = [
  {
    id: "in_story_0906",
    number: null,
    status: "draft",
    currency: "usd",
    amount_due: 4900,
    amount_paid: 0,
    amount_remaining: 4900,
    created: unixSeconds(2026, 8, 6),
    hosted_invoice_url: null,
    invoice_pdf: null,
  },
  {
    id: "in_story_0806",
    number: "STORY-0006",
    status: "open",
    currency: "usd",
    amount_due: 4900,
    amount_paid: 0,
    amount_remaining: 4900,
    created: unixSeconds(2026, 7, 6),
    hosted_invoice_url: "https://invoice.example.com/STORY-0006",
    invoice_pdf: "https://invoice.example.com/STORY-0006.pdf",
  },
  {
    id: "in_story_0706",
    number: "STORY-0005",
    status: "paid",
    currency: "usd",
    amount_due: 4900,
    amount_paid: 4900,
    amount_remaining: 0,
    created: unixSeconds(2026, 6, 6),
    hosted_invoice_url: "https://invoice.example.com/STORY-0005",
    invoice_pdf: "https://invoice.example.com/STORY-0005.pdf",
  },
  {
    id: "in_story_0606",
    number: "STORY-0004",
    status: "uncollectible",
    currency: "usd",
    amount_due: 12000,
    amount_paid: 0,
    amount_remaining: 12000,
    created: unixSeconds(2026, 5, 6),
    hosted_invoice_url: "https://invoice.example.com/STORY-0004",
    invoice_pdf: "https://invoice.example.com/STORY-0004.pdf",
  },
  {
    id: "in_story_0506",
    number: "STORY-0003",
    status: "void",
    currency: "usd",
    amount_due: 0,
    amount_paid: 0,
    amount_remaining: 0,
    created: unixSeconds(2026, 4, 6),
    hosted_invoice_url: "https://invoice.example.com/STORY-0003",
    invoice_pdf: null,
  },
  {
    id: "in_story_0406",
    number: "STORY-0002",
    status: "paid",
    currency: "eur",
    amount_due: 4500,
    amount_paid: 4500,
    amount_remaining: 0,
    created: unixSeconds(2026, 3, 6),
    hosted_invoice_url: "https://invoice.example.com/STORY-0002",
    invoice_pdf: "https://invoice.example.com/STORY-0002.pdf",
  },
];

/** A cache holding one fully loaded page of invoices under the list's key. */
function withInvoices(page: InvoiceListResponse) {
  return withQueryCache((client) => {
    const data: InfiniteData<InvoiceListResponse, string | undefined> = {
      pages: [page],
      pageParams: [undefined],
    };
    client.setQueryData(
      organizationsBillingInvoicesRetrieveInfiniteQueryKey(),
      data,
    );
  });
}

const meta = {
  title: "Settings/Billing/InvoicesTable",
  component: InvoicesTable,
  parameters: {
    layout: "padded",
  },
  decorators: [
    (Story) => (
      <div className="w-[760px]">
        <Story />
      </div>
    ),
  ],
  play: async ({ canvasElement }) => {
    await userEvent.click(
      await within(canvasElement).findByRole("button", {
        name: "Show Invoices",
      }),
    );
  },
} satisfies Meta<typeof InvoicesTable>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * Six invoices across every status: the first four rows show, Show more
 * folds the rest, and the draft row has neither a view nor a download action
 * because Stripe has not finalized it.
 */
export const Populated: Story = {
  decorators: [withInvoices({ invoices: INVOICES, has_more: false })],
};

/** An account that has never been billed. */
export const Empty: Story = {
  decorators: [withInvoices({ invoices: [], has_more: false })],
};
