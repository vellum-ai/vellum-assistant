import { Check, Circle, Sparkles, TriangleAlert } from "lucide-react";
import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";

import { Tag } from "./tag";

const meta: Meta<typeof Tag> = {
  title: "Components/Tag",
  component: Tag,
  args: {
    children: "Draft",
    tone: "neutral",
  },
  argTypes: {
    tone: {
      control: "select",
      options: ["neutral", "positive", "negative", "warning", "info"],
    },
    children: { control: "text" },
  },
};

export default meta;

type Story = StoryObj<typeof Tag>;

/** Arg-driven: edit the label and flip the tone from the Controls panel. */
export const Default: Story = {};

/** Every tone at a glance. */
export const Tones: Story = {
  render: () => (
    <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
      <Tag tone="neutral">Neutral</Tag>
      <Tag tone="positive">Positive</Tag>
      <Tag tone="negative">Negative</Tag>
      <Tag tone="warning">Warning</Tag>
      <Tag tone="info">Info</Tag>
    </div>
  ),
};

/** A tone-matched leading icon reads faster than color alone. */
export const WithLeftIcon: Story = {
  args: { tone: "positive", leftIcon: <Check />, children: "Passing" },
};

/** A gallery of icon + tone pairings. */
export const IconGallery: Story = {
  render: () => (
    <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
      <Tag tone="positive" leftIcon={<Check />}>
        Passing
      </Tag>
      <Tag tone="warning" leftIcon={<TriangleAlert />}>
        Degraded
      </Tag>
      <Tag tone="info" leftIcon={<Sparkles />}>
        New
      </Tag>
      <Tag tone="neutral" leftIcon={<Circle />}>
        Idle
      </Tag>
    </div>
  ),
};

/**
 * `onRemove` turns the chip into a dismissible filter pill. Stateful, so this
 * story owns a render function that manages the list.
 */
export const Removable: Story = {
  render: () => {
    function RemovableDemo() {
      const [tags, setTags] = useState(["design", "web", "chat"]);
      return (
        <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
          {tags.map((tag) => (
            <Tag
              key={tag}
              tone="info"
              onRemove={() => setTags((prev) => prev.filter((t) => t !== tag))}
              removeLabel={`Remove ${tag}`}
            >
              {tag}
            </Tag>
          ))}
          {tags.length === 0 ? (
            <button
              type="button"
              onClick={() => setTags(["design", "web", "chat"])}
              className="text-body-small-default text-[var(--content-tertiary)] underline"
            >
              Reset
            </button>
          ) : null}
        </div>
      );
    }
    return <RemovableDemo />;
  },
};
