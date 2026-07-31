import { Monitor, Moon, Sun } from "lucide-react";
import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";

import { SegmentControl, type SegmentControlItem } from "./segment-control";

const meta: Meta<typeof SegmentControl> = {
  title: "Components/SegmentControl",
  component: SegmentControl,
};

export default meta;

type Story = StoryObj<typeof SegmentControl>;

type Size = "small" | "medium" | "large";

const SIZE_ITEMS: SegmentControlItem<Size>[] = [
  { value: "small", label: "Small" },
  { value: "medium", label: "Medium" },
  { value: "large", label: "Large" },
];

export const Default: Story = {
  render: () => {
    function DefaultDemo() {
      const [value, setValue] = useState<Size>("medium");
      return (
        <div style={{ width: 320 }}>
          <SegmentControl
            items={SIZE_ITEMS}
            value={value}
            onChange={setValue}
            ariaLabel="Size"
          />
        </div>
      );
    }
    return <DefaultDemo />;
  },
};

type ThemePreference = "system" | "light" | "dark";

const THEME_ITEMS: SegmentControlItem<ThemePreference>[] = [
  { value: "system", label: "System", icon: <Monitor className="h-4 w-4" /> },
  { value: "light", label: "Light", icon: <Sun className="h-4 w-4" /> },
  { value: "dark", label: "Dark", icon: <Moon className="h-4 w-4" /> },
];

/** Matches the real usage in the theme picker: icon-only, with tooltips. */
export const IconOnly: Story = {
  render: () => {
    function IconOnlyDemo() {
      const [value, setValue] = useState<ThemePreference>("system");
      return (
        <SegmentControl
          items={THEME_ITEMS}
          value={value}
          onChange={setValue}
          ariaLabel="Theme"
          iconOnly
        />
      );
    }
    return <IconOnlyDemo />;
  },
};

type Frequency = "daily" | "weekly" | "monthly";

const SUBLABEL_ITEMS: SegmentControlItem<Frequency>[] = [
  { value: "daily", label: "Daily", sublabel: "Every day" },
  { value: "weekly", label: "Weekly", sublabel: "Every 7 days" },
  { value: "monthly", label: "Monthly", sublabel: "Every 30 days" },
];

export const WithSublabels: Story = {
  render: () => {
    function SublabelsDemo() {
      const [value, setValue] = useState<Frequency>("weekly");
      return (
        <div style={{ width: 360 }}>
          <SegmentControl
            items={SUBLABEL_ITEMS}
            value={value}
            onChange={setValue}
            ariaLabel="Frequency"
          />
        </div>
      );
    }
    return <SublabelsDemo />;
  },
};

const DISABLED_SEGMENT_ITEMS: SegmentControlItem<Size>[] = [
  { value: "small", label: "Small" },
  { value: "medium", label: "Medium", disabled: true },
  { value: "large", label: "Large" },
];

export const WithDisabledSegment: Story = {
  render: () => {
    function DisabledSegmentDemo() {
      const [value, setValue] = useState<Size>("small");
      return (
        <div style={{ width: 320 }}>
          <SegmentControl
            items={DISABLED_SEGMENT_ITEMS}
            value={value}
            onChange={setValue}
            ariaLabel="Size"
          />
        </div>
      );
    }
    return <DisabledSegmentDemo />;
  },
};

/** No segment starts active; the first enabled one takes the roving tab stop. */
export const Unset: Story = {
  render: () => {
    function UnsetDemo() {
      const [value, setValue] = useState<Size | null>(null);
      return (
        <div style={{ width: 320 }}>
          <SegmentControl
            items={SIZE_ITEMS}
            value={value}
            onChange={setValue}
            ariaLabel="Size"
          />
        </div>
      );
    }
    return <UnsetDemo />;
  },
};
