import type { Meta, StoryObj } from "@storybook/react-vite";

import { Button } from "@vellumai/design-library";

import { DetailCard } from "./detail-card";
import { InsetDetailCard } from "./inset-detail-card";

/**
 * The details card for **inset** surfaces: a sidepanel body, a modal, or
 * anything already nested inside its own card. `DetailCard` is the page-level
 * counterpart. See `Components/DetailCard` for the side-by-side.
 */
const meta: Meta<typeof InsetDetailCard> = {
  title: "Components/InsetDetailCard",
  component: InsetDetailCard,
  // No union props here; the slots are marked uneditable so Controls offers
  // only the text props it can actually drive.
  argTypes: {
    accessory: { control: false },
    children: { control: false },
  },
  parameters: { layout: "centered" },
  decorators: [
    (Story) => (
      <div className="w-[420px]">
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof InsetDetailCard>;

/** A label/value stack, the shape these panels most often wrap. */
function Rows({
  rows,
}: {
  rows: [label: string, value: string][];
}) {
  return (
    <div className="space-y-2 text-body-medium-lighter">
      {rows.map(([label, value]) => (
        <div key={label} className="flex items-center justify-between gap-4">
          <span className="text-[var(--content-secondary)]">{label}</span>
          <span className="text-[var(--content-default)]">{value}</span>
        </div>
      ))}
    </div>
  );
}

const DETAIL_ROWS: [string, string][] = [
  ["Status", "On"],
  ["Model profile", "Balanced"],
  ["Repeats", "Every 1 hr"],
  ["Next run", "Today at 3:00 PM"],
  ["Last run", "Today at 2:00 PM"],
];

export const Default: Story = {
  args: {
    title: "Details",
    children: <Rows rows={DETAIL_ROWS} />,
  },
};

export const WithSubtitle: Story = {
  args: {
    title: "Details",
    subtitle: "How and when this task runs.",
    children: <Rows rows={DETAIL_ROWS} />,
  },
};

/** The header's right-hand slot, e.g. a pagination control. */
export const WithAccessory: Story = {
  args: {
    title: "Recent runs",
    accessory: (
      <Button variant="outlined" size="compact">
        Load more
      </Button>
    ),
    children: <Rows rows={[["Today at 2:00 PM", "Completed"]]} />,
  },
};

/** No header: just the inset surface around arbitrary content. */
export const Titleless: Story = {
  args: { children: <Rows rows={DETAIL_ROWS} /> },
};

/**
 * The case this component exists for. Both cards sit inside a mock sidepanel
 * body: `DetailCard`'s 20px title competes with the panel's own header title
 * and its 16px corners tie with the panel's, while `InsetDetailCard` reads
 * as nested.
 */
export const InsetVsPageLevel: StoryObj = {
  render: () => (
    <div className="flex h-full flex-col overflow-hidden rounded-xl bg-[var(--surface-lift)]">
      <div className="flex shrink-0 items-center gap-3 border-b border-[var(--border-hover)] px-5 py-4">
        <span className="text-title-medium leading-snug text-[var(--content-default)]">
          Heartbeat
        </span>
      </div>
      <div className="space-y-6 px-4 py-4">
        <div className="space-y-2">
          <p className="text-body-small-default text-[var(--content-tertiary)]">
            InsetDetailCard: 16px title, 12px corners
          </p>
          <InsetDetailCard title="Details">
            <Rows rows={DETAIL_ROWS} />
          </InsetDetailCard>
        </div>
        <div className="space-y-2">
          <p className="text-body-small-default text-[var(--content-tertiary)]">
            DetailCard: 20px title, 16px corners (too large here)
          </p>
          <DetailCard title="Details">
            <Rows rows={DETAIL_ROWS} />
          </DetailCard>
        </div>
      </div>
    </div>
  ),
};
