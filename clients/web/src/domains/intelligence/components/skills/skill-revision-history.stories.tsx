import type { Meta, StoryObj } from "@storybook/react-vite";

import type { SkillRevision } from "@/hooks/use-skill-history";

import { SkillRevisionList } from "./skill-revision-history";

/**
 * Stories for the skill detail History tab.
 *
 * `SkillRevisionList` is the presentational half of
 * {@link import("./skill-revision-history").SkillRevisionHistory}, so these
 * render fixture revisions directly with no query cache to seed. The diffs are
 * shaped like real `git show` output, including the index and mode lines the
 * parser has to discard.
 */

const SKILL_ID = "release-triage";

/** Relative-time copy is the point of the collapsed row, so dates are offsets. */
function daysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

const MULTI_FILE: SkillRevision = {
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
};

const SINGLE_LINE: SkillRevision = {
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
};

const CREATION: SkillRevision = {
  id: "01aa77c",
  changedAt: daysAgo(24),
  files: ["SKILL.md", "scripts/triage.py"],
  diff: `diff --git a/skills/release-triage/SKILL.md b/skills/release-triage/SKILL.md
new file mode 100644
index 0000000..1234567
--- /dev/null
+++ b/skills/release-triage/SKILL.md
@@ -0,0 +1,3 @@
+# Release triage
+
+Read the release label first.
diff --git a/skills/release-triage/scripts/triage.py b/skills/release-triage/scripts/triage.py
new file mode 100644
index 0000000..7654321
--- /dev/null
+++ b/skills/release-triage/scripts/triage.py
@@ -0,0 +1,2 @@
+import sys
+print(sys.argv)
`,
};

const meta: Meta<typeof SkillRevisionList> = {
  title: "Intelligence/Skills/SkillRevisionList",
  component: SkillRevisionList,
  parameters: { layout: "padded" },
  args: { skillId: SKILL_ID, truncatedByCompaction: false },
};

export default meta;
type Story = StoryObj<typeof SkillRevisionList>;

/** The common case: a few updates, collapsed, newest first. */
export const Default: Story = {
  args: { revisions: [MULTI_FILE, SINGLE_LINE, CREATION] },
};

/**
 * One update spanning `SKILL.md` and a companion file. Expanding it shows a
 * single combined diff with a header per file, not two separate entries.
 */
export const SingleRevision: Story = {
  args: { revisions: [MULTI_FILE] },
};

/**
 * The caveat that matters most for trust: workspace history is periodically
 * squashed, so the oldest entry is a floor and not the skill's creation.
 */
export const TruncatedByCompaction: Story = {
  args: {
    revisions: [MULTI_FILE, SINGLE_LINE],
    truncatedByCompaction: true,
  },
};

/**
 * A skill that exists but has never been edited. Distinct from the tab being
 * absent, which is what an assistant without the history route produces.
 */
export const NoChangesYet: Story = {
  args: { revisions: [] },
};

/** A diff with more than one hunk, so the gap separator is visible. */
export const MultipleHunks: Story = {
  args: {
    revisions: [
      {
        id: "77bb31e",
        changedAt: daysAgo(1),
        files: ["SKILL.md"],
        diff: `diff --git a/skills/release-triage/SKILL.md b/skills/release-triage/SKILL.md
index ccc3333..ddd4444 100644
--- a/skills/release-triage/SKILL.md
+++ b/skills/release-triage/SKILL.md
@@ -3,3 +3,3 @@
 # Release triage
-Read the label.
+Read the release label first.
@@ -41,3 +41,4 @@
 ## Posting
-Post in the channel.
+Post in the release thread, not the channel.
+Tag the owning team.
`,
      },
    ],
  },
};
