import type { Meta, StoryObj } from "@storybook/react-vite";

import { FileDiffView } from "./file-diff-view";

/**
 * A unified before/after diff, shared by the ACP run view, skill revision
 * history, and the `file_edit` tool detail.
 *
 * Unified rather than side-by-side because the tool drawer is 400px at its
 * default, which is not two columns of code. Rows soft-wrap rather than
 * scrolling horizontally, so a long line stays readable at that width instead
 * of hiding its tail behind a scrollbar the reader has to find. Narrow the
 * Storybook viewport to check that: nothing here should ever scroll sideways.
 */
const meta = {
  title: "Chat/FileDiffView",
  component: FileDiffView,
  parameters: { layout: "padded" },
} satisfies Meta<typeof FileDiffView>;

export default meta;
type Story = StoryObj<typeof FileDiffView>;

/** One line added into surrounding context. */
export const OneAddedLine: Story = {
  args: {
    path: "clients/web/src/domains/chat/utils/risk.ts",
    oldText: 'const VALID = new Set([\n  "low",\n  "medium",\n]);\n',
    newText: 'const VALID = new Set([\n  "low",\n  "medium",\n  "high",\n]);\n',
  },
};

/** Additions and removals together, the ordinary edit. */
export const Mixed: Story = {
  args: {
    path: "clients/web/src/domains/chat/components/risk-chip.tsx",
    oldText:
      'import { usePointerCoarse } from "@/utils/pointer";\n\nconst coarse = usePointerCoarse();\nif (coarse) {\n  return <Text />;\n}\n',
    newText:
      'import { useHoverCapable } from "@/hooks/use-hover-affordance";\n\nconst hoverCapable = useHoverCapable();\nif (!hoverCapable) {\n  return <Text />;\n}\n',
  },
};

/** A new file: nothing on the left, so every line is an addition. */
export const NewFile: Story = {
  args: {
    path: "clients/web/src/domains/chat/utils/tool-input.ts",
    oldText: "",
    newText:
      'export function readToolInputString(\n  input: Record<string, unknown>,\n  ...keys: string[]\n): string {\n  for (const key of keys) {\n    const value = input[key];\n    if (typeof value === "string" && value.trim().length > 0) {\n      return value.trim();\n    }\n  }\n  return "";\n}\n',
  },
};

/** A deleted file: nothing on the right. */
export const DeletedFile: Story = {
  args: {
    path: "clients/web/src/domains/chat/components/tool-meta-row.tsx",
    oldText: "export function ToolMetaRow() {\n  return null;\n}\n",
    newText: "",
  },
};

/**
 * A line far wider than the panel. It wraps rather than scrolling, which is the
 * property that makes a unified diff work at the drawer's width.
 */
export const LongLineWraps: Story = {
  args: {
    path: "clients/web/src/domains/chat/components/tool-detail-panel.tsx",
    oldText:
      'const className = "mt-0.5 flex min-w-0 items-center gap-2 text-body-small-lighter truncate text-[var(--content-tertiary)]";\n',
    newText:
      'const className = "mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-body-small-lighter shrink-0 truncate text-[var(--content-tertiary)]";\n',
  },
};

/**
 * Past `MAX_DIFF_LINES` the LCS is skipped rather than run, since it is
 * O(n*m) and would lock the renderer. A sentence takes the place of the rows.
 */
export const TooLarge: Story = {
  args: {
    path: "clients/web/src/generated/daemon/types.gen.ts",
    oldText: Array.from({ length: 2100 }, (_, i) => `line ${i}`).join("\n"),
    newText: Array.from({ length: 2100 }, (_, i) => `line ${i} changed`).join(
      "\n",
    ),
  },
};
