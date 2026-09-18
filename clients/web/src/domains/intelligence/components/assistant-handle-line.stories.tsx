import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";

import { AssistantHandleLineView } from "./assistant-handle-line";

/**
 * The `@handle` line under the assistant page's greeting, shown beneath a
 * stand-in headline so its weight against the title can be judged. Hover it
 * for the pencil.
 */
const meta: Meta<typeof AssistantHandleLineView> = {
  title: "Intelligence/AssistantHandleLine",
  component: AssistantHandleLineView,
  args: { handle: "velly", onEdit: fn().mockName("onEdit") },
  decorators: [
    (Story) => (
      <div className="flex flex-col items-center gap-2 p-12">
        <h1
          className="text-[3.25rem] leading-none text-[var(--content-strong)]"
          style={{ fontFamily: "var(--font-serif)" }}
        >
          {/* A stand-in for the page's greeting. */}
          Hi, I'm Velly
        </h1>
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof AssistantHandleLineView>;

export const Default: Story = {};
