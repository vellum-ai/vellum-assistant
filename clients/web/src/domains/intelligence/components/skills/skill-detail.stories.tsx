import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { type ComponentProps, useState } from "react";

import type { SkillInfo } from "@/domains/intelligence/skills/types";
import {
  skillsByIdFilesContentGetQueryKey,
  skillsByIdFilesGetQueryKey,
  skillsByIdHistoryGetQueryKey,
} from "@/generated/daemon/@tanstack/react-query.gen";

import { SkillDetail } from "./skill-detail";

/**
 * The whole skill detail page as it renders at
 * `/assistant/skills/:skillId`, the surface you land on from My
 * Superpowers. Shows the History tab in place next to Files, with the real
 * header, origin badge, and lineage link around it.
 *
 * Both the files and history queries are seeded into a story-local cache, so
 * the stories exercise the shipped components with no network and no mocks.
 */

const ASSISTANT_ID = "asst_story";
const SKILL_ID = "release-triage";

const SKILL: SkillInfo = {
  id: SKILL_ID,
  name: "Release triage",
  description:
    "Check the release label, group failures by owning team, and post the summary in the release thread.",
  emoji: "🚦",
  kind: "installed",
  status: "enabled",
  origin: "assistant-memory",
  category: "Engineering",
};

const SKILL_MD = `---
name: Release triage
description: Triage a release's failing checks.
---

# Release triage

Read the release label first.
Skip drafts unless the label is explicit.

## Grouping

Group the failures by owning team, not by file: one file often spans
three teams. See references/owners.md.
`;

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

const REVISIONS = [
  {
    id: "9c1f2ab",
    changedAt: daysAgo(2),
    files: ["SKILL.md", "references/owners.md"],
    diff: `diff --git a/skills/release-triage/SKILL.md b/skills/release-triage/SKILL.md
index 1a2b3c4..5d6e7f8 100644
--- a/skills/release-triage/SKILL.md
+++ b/skills/release-triage/SKILL.md
@@ -18,3 +18,4 @@
 ## Grouping
-Group the failures by file.
+Group the failures by owning team, not by file: one file often spans
+three teams. See references/owners.md.
diff --git a/skills/release-triage/references/owners.md b/skills/release-triage/references/owners.md
new file mode 100644
index 0000000..9999999
--- /dev/null
+++ b/skills/release-triage/references/owners.md
@@ -0,0 +1,2 @@
+Platform owns the gateway.
+Assistant owns the daemon.
`,
  },
  {
    id: "4de88b1",
    changedAt: daysAgo(9),
    files: ["SKILL.md"],
    diff: `diff --git a/skills/release-triage/SKILL.md b/skills/release-triage/SKILL.md
index aaa1111..bbb2222 100644
--- a/skills/release-triage/SKILL.md
+++ b/skills/release-triage/SKILL.md
@@ -6,2 +6,3 @@
 Read the release label first.
+Skip drafts unless the label is explicit.
`,
  },
];

const FILES = [
  {
    name: "SKILL.md",
    path: "SKILL.md",
    size: SKILL_MD.length,
    mimeType: "text/markdown",
    isBinary: false,
  },
  {
    name: "references",
    path: "references",
    size: 0,
    mimeType: "inode/directory",
    isBinary: false,
  },
  {
    name: "triage.py",
    path: "scripts/triage.py",
    size: 210,
    mimeType: "text/x-python",
    isBinary: false,
  },
];

/**
 * Build a cache seeded for one story. `historySupported: false` leaves the
 * history query resolved to `null`, which is what an assistant without the
 * route produces and what hides the tab strip.
 */
function seededClient(options: {
  historySupported: boolean;
  revisions?: typeof REVISIONS;
  truncatedByCompaction?: boolean;
}): QueryClient {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  const path = { assistant_id: ASSISTANT_ID, id: SKILL_ID };

  client.setQueryData(skillsByIdFilesGetQueryKey({ path }), {
    skill: SKILL,
    files: FILES,
  });
  client.setQueryData(
    skillsByIdFilesContentGetQueryKey({ path, query: { path: "SKILL.md" } }),
    {
      path: "SKILL.md",
      name: "SKILL.md",
      size: SKILL_MD.length,
      mimeType: "text/markdown",
      isBinary: false,
      content: SKILL_MD,
    },
  );
  client.setQueryData(
    skillsByIdHistoryGetQueryKey({ path }),
    options.historySupported
      ? {
          skillId: SKILL_ID,
          revisions: options.revisions ?? REVISIONS,
          truncatedByCompaction: options.truncatedByCompaction ?? false,
        }
      : null,
  );
  return client;
}

/**
 * Holds the selected tab the way the route page does (there it rides
 * `?tab=`), so clicking the tab strip works in a story. `tab` in args is the
 * tab the story opens on.
 */
function SkillDetailWithTabState(props: ComponentProps<typeof SkillDetail>) {
  const [tab, setTab] = useState(props.tab);
  return <SkillDetail {...props} tab={tab} onTabChange={setTab} />;
}

const meta: Meta<typeof SkillDetail> = {
  title: "Intelligence/Skills/SkillDetail",
  component: SkillDetail,
  parameters: { layout: "fullscreen" },
  render: (args) => <SkillDetailWithTabState {...args} />,
  args: {
    assistantId: ASSISTANT_ID,
    skill: SKILL,
    sourceConversationId: "conv_story",
    tab: "files",
    onTabChange: () => {},
    onBack: () => {},
    onRemove: () => {},
  },
};

export default meta;
type Story = StoryObj<typeof SkillDetail>;

/**
 * Decorator giving the page its usual viewport height. The router comes from
 * Storybook's own preview wrapper, so this must not add another one.
 */
function withShell(client: QueryClient) {
  return function Decorator(Story: () => React.ReactElement) {
    return (
      <QueryClientProvider client={client}>
        <div className="h-screen p-6">
          <Story />
        </div>
      </QueryClientProvider>
    );
  };
}

/**
 * Landing on the page: Files is selected and History sits beside it. Click
 * History to see the revision list inside the page's own card. This and the
 * story below both open on Files.
 */
export const Default: Story = {
  decorators: [withShell(seededClient({ historySupported: true }))],
};

/**
 * Arriving by deep link: the in-chat Level Up card links to
 * `/assistant/skills/:skillId?tab=history`, so the page opens straight onto
 * the revision list.
 */
export const HistoryDeepLink: Story = {
  decorators: [withShell(seededClient({ historySupported: true }))],
  args: { tab: "history" },
};

/** Workspace history was squashed, so the list carries its caveat. */
export const HistoryTruncated: Story = {
  decorators: [
    withShell(
      seededClient({ historySupported: true, truncatedByCompaction: true }),
    ),
  ],
};

/**
 * No tab strip at all. A skill with no recorded revisions renders exactly as
 * the page did before history existed, rather than offering a History tab
 * that opens onto an empty state.
 */
export const NoHistoryYet: Story = {
  decorators: [
    withShell(seededClient({ historySupported: true, revisions: [] })),
  ],
};

/**
 * Also no tab strip, by the same rule: an assistant that predates the history
 * route reports nothing, which is indistinguishable from having nothing to
 * report as far as the page is concerned.
 */
export const HistoryUnsupported: Story = {
  decorators: [withShell(seededClient({ historySupported: false }))],
};
