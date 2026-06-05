import type { Meta, StoryObj } from "@storybook/react-vite";

import {
  runConfirmationSurface,
  runOAuthSurface,
  runResultCardSurface,
  runResultWorkResultSurface,
  runTaskProgressSurface,
} from "./activation-personas";
import {
  PersonaColumns,
  StaticSurface,
  SurfacePreview,
} from "./activation-story-helpers";

/**
 * Moment 3: Run — the assistant is doing work, visibly, on the user's actual
 * data. Ownership signal: the result subtitle and metadata carry numbers from
 * THEIR data ("2 need a reply" with real senders), not "5 emails processed".
 *
 * The result is mocked BOTH ways (JARVIS-1112 decision): the plain `card` the
 * spec §3.3 describes, and the shipped `work_result` surface (#33472), which now
 * supports the per-metric tone the spec assumed was unavailable. Compare the two
 * Result* stories side by side.
 * See activation-moments-visual-spec.md §"Moment 3".
 */
const meta: Meta = {
  title: "ActivationFlow/Moment3-Run",
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="max-w-[1100px]">
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj;

export const OAuthInline: Story = {
  render: () => (
    <PersonaColumns
      render={(p) => <SurfacePreview initialSurface={runOAuthSurface(p)} />}
    />
  ),
};

export const TaskProgressAllPending: Story = {
  name: "TaskProgress (all pending)",
  render: () => (
    <PersonaColumns
      render={(p) => (
        <StaticSurface surface={runTaskProgressSurface(p, "all-pending")} />
      )}
    />
  ),
};

export const TaskProgressMidRun: Story = {
  name: "TaskProgress (mid-run, live count)",
  render: () => (
    <PersonaColumns
      render={(p) => (
        <StaticSurface surface={runTaskProgressSurface(p, "mid-run")} />
      )}
    />
  ),
};

export const TaskProgressDone: Story = {
  name: "TaskProgress (done)",
  render: () => (
    <PersonaColumns
      render={(p) => (
        <StaticSurface surface={runTaskProgressSurface(p, "done")} />
      )}
    />
  ),
};

export const TaskProgressFailed: Story = {
  name: "TaskProgress (step failed)",
  render: () => (
    <PersonaColumns
      render={(p) => (
        <StaticSurface surface={runTaskProgressSurface(p, "failed")} />
      )}
    />
  ),
};

export const ResultCardSpec: Story = {
  name: "Result — card (spec §3.3)",
  render: () => (
    <PersonaColumns
      render={(p) => <StaticSurface surface={runResultCardSurface(p)} />}
    />
  ),
};

export const ResultWorkResultShipped: Story = {
  name: "Result — work_result (shipped)",
  render: () => (
    <PersonaColumns
      render={(p) => <StaticSurface surface={runResultWorkResultSurface(p)} />}
    />
  ),
};

export const ConfirmationDestructive: Story = {
  name: "Confirmation (destructive)",
  render: () => (
    <PersonaColumns
      render={(p) => (
        <SurfacePreview initialSurface={runConfirmationSurface(p)} />
      )}
    />
  ),
};
