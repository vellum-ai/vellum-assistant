import type { Meta, StoryObj } from "@storybook/react-vite";

import { client as daemonClient } from "@/generated/daemon/client.gen";
import { IntelligenceSectionStoryFrame } from "@/intelligence-section-story-frame";
import { withQueryCache } from "@/lib/story-query-cache";
import { stubClientFetch } from "@/lib/stub-client-fetch";

import {
  seedWorkspaceStory,
  workspaceStoryBinaryFetch,
  WORKSPACE_STORY_ASSISTANT_ID,
} from "../workspace-story-fixtures";
import { WorkspaceBrowser } from "./workspace-browser";

const meta: Meta<typeof IntelligenceSectionStoryFrame> = {
  title: "Workspace/Browser",
  component: IntelligenceSectionStoryFrame,
  tags: ["!autodocs"],
  parameters: {
    layout: "fullscreen",
    controls: { disable: true },
    router: {
      initialEntries: ["/assistant/workspace?file=README.md"],
    },
  },
  decorators: [withQueryCache(seedWorkspaceStory)],
  beforeEach: () => stubClientFetch(daemonClient, workspaceStoryBinaryFetch),
  args: {
    path: "/assistant/workspace",
    outlet: <WorkspaceBrowser assistantId={WORKSPACE_STORY_ASSISTANT_ID} />,
  },
};

export default meta;

type Story = StoryObj<typeof IntelligenceSectionStoryFrame>;

/** A desktop viewport with a pane too narrow to fit the inline file tree. */
export const CompactDesktopPane: Story = {
  decorators: [
    (Story) => (
      <div className="mx-auto w-full max-w-xl">
        <Story />
      </div>
    ),
  ],
  parameters: {
    router: {
      initialEntries: [
        "/assistant/workspace?file=notes/projects/example/project-plan-with-a-long-descriptive-filename.md",
      ],
    },
  },
};

/** The same production browser with enough room for the inline tree. */
export const WideDesktopPane: Story = {};
