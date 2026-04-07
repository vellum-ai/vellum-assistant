# Proposal: Add activation hints to 4 bundled skills

## Problem

The document editor tab doesn't open by default when users work on long-form content. The assistant outputs raw markdown or file attachments instead of using the rich text editor. Users have to explicitly ask "can you open this in the document editor tab?"

## Root cause

Skill routing is driven by `activation-hints` in SKILL.md frontmatter. These hints are seeded into the memory graph as capability nodes and retrieved via semantic search to help the LLM decide when to `skill_load`. Only 6 of 31 bundled skills have hints today — the document skill is not one of them.

## How activation hints work

1. Each skill's SKILL.md frontmatter can declare `activation-hints` (when to load) and `avoid-when` (when not to load)
2. On startup, `seedSkillGraphNodes()` builds a capability node per skill using the display name, description, and hints
3. These nodes are embedded and indexed in the vector store
4. During conversation, semantic retrieval surfaces relevant capability nodes based on the user's message
5. The LLM sees the hint and decides to call `skill_load` → the skill's tools become available

Example of what gets stored in the memory graph:
```
The "Document" skill (document) is available. Write, draft, or compose
long-form text (blog posts, articles, essays, reports, guides).
Use when: User asks to write, draft, or collaborate on long-form content —
always use the document editor over raw markdown or file attachments.
```

## Proposed changes

### 1. `document` — the primary fix

**Why:** LLM defaults to inline markdown or file attachments instead of opening the editor. This is the wrong UX for any collaborative long-form content work.

```diff
--- a/assistant/src/config/bundled-skills/document/SKILL.md
+++ b/assistant/src/config/bundled-skills/document/SKILL.md
@@ -6,6 +6,10 @@ metadata:
   emoji: "📄"
   vellum:
     display-name: "Document"
+    activation-hints:
+      - "User asks to write, draft, or collaborate on long-form content — always use the document editor"
+      - "Prefer the document editor over raw markdown or file attachments for content longer than a few paragraphs"
+      - "When a file attachment contains a draft or document the user wants to iterate on, open it in the editor"
 ---
```

### 2. `app-builder` — same class of problem

**Why:** Same issue as document — the LLM might output raw HTML in chat instead of opening the app preview sandbox. The app builder has a rich preview experience that should be the default for anything interactive.

```diff
--- a/assistant/src/config/bundled-skills/app-builder/SKILL.md
+++ b/assistant/src/config/bundled-skills/app-builder/SKILL.md
@@ -7,6 +7,9 @@ metadata:
   vellum:
     display-name: "App Builder"
     includes:
       - "frontend-design"
+    activation-hints:
+      - "User asks to build an app, dashboard, tool, calculator, game, tracker, or interactive page"
+      - "Prefer the app sandbox over outputting raw HTML/CSS/JS in chat"
 ---
```

### 3. `tasks` — disambiguation from schedule/heartbeat

**Why:** "Remind me to do X", "add this to my list", and "I need to do X" are ambiguous between tasks, schedule, and heartbeat. Tool-description routing helps but a capability-level hint strengthens the signal.

```diff
--- a/assistant/src/config/bundled-skills/tasks/SKILL.md
+++ b/assistant/src/config/bundled-skills/tasks/SKILL.md
@@ -6,6 +6,10 @@ metadata:
   emoji: "✅"
   vellum:
     display-name: "Tasks"
+    activation-hints:
+      - "User wants to add, check, or manage items on their to-do list or task queue"
+      - "For one-off action items, not recurring automations (use schedule for those)"
+    avoid-when:
+      - "User wants recurring/scheduled automation — use the schedule skill instead"
 ---
```

### 4. `contacts` — check before asking

**Why:** When the user says "send a message to Sarah", the LLM should check the contact store for Sarah's channels rather than asking the user for her email/phone. The hint nudges the LLM to load contacts proactively.

```diff
--- a/assistant/src/config/bundled-skills/contacts/SKILL.md
+++ b/assistant/src/config/bundled-skills/contacts/SKILL.md
@@ -6,6 +6,9 @@ metadata:
   emoji: "👥"
   vellum:
     display-name: "Contacts"
+    activation-hints:
+      - "Look up contact info before asking the user for email addresses or phone numbers"
+      - "User wants to manage who can message the assistant, or create/revoke invite links"
 ---
```

## Skills intentionally left without hints (21)

These don't need hints because their descriptions are distinctive enough for semantic matching, or they're typically loaded explicitly by the user:

- **Channel-specific** (gmail, outlook, slack, google-calendar, outlook-calendar): Skill name + description provide strong enough signal
- **Media** (transcribe, media-processing, image-studio): Action-specific descriptions, no competing default behavior
- **Meta/internal** (settings, skill-management, conversations, notifications): Loaded in response to explicit user requests
- **Niche** (playbooks, sequences, screen-watch, watcher, followups, chatgpt-import, computer-use, acp): Narrow use cases where description suffices

## No code changes required

The `activation-hints` and `avoid-when` frontmatter fields are already fully supported:
- Parsed during skill catalog load (`assistant/src/config/skills.ts`)
- Mapped to `SkillSummary.activationHints` / `SkillSummary.avoidWhen`
- Consumed by `buildSkillContent()` in `assistant/src/memory/graph/capability-seed.ts`
- Seeded, embedded, and retrieved via the existing memory graph pipeline

The only changes are to the 4 SKILL.md files above.
