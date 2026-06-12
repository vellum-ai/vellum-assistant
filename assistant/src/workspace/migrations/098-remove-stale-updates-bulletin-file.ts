import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { WorkspaceMigration } from "./types.js";

const MIGRATION_ID = "098-remove-stale-updates-bulletin-file";

/**
 * Remove stale release-note bulletins from `<workspace>/UPDATES.md`.
 *
 * Release notes used to be appended to `<workspace>/UPDATES.md` by workspace
 * migrations and processed by a background conversation dispatched at daemon
 * startup. That processing job has been removed, so any accumulated release
 * notes in the file will never be consumed — they are stale noise that the
 * agent could stumble over.
 *
 * Removal is surgical: only the exact block texts written by the historical
 * release-note migrations (duplicated below per the migrations AGENTS.md
 * self-containment rule) are removed. Config-quarantine notes, user-authored
 * content, and any block whose text no longer matches (e.g. hand-edited) are
 * preserved. The file itself is deleted only when nothing but whitespace
 * remains after cleanup.
 *
 * Idempotent: removed blocks cannot match again, the newline collapse is
 * stable, and deleting an already-deleted file is a no-op.
 */

// ---------------------------------------------------------------------------
// Exact block texts appended by the historical release-note migrations.
// Each constant mirrors the RELEASE_NOTE template in its source migration
// (043, 045, 049, 053, 055, 056, 058, 063, 068, 078) verbatim. The 067 text
// mirrors the constant in 071-remove-safe-storage-release-note.ts, which
// already removes that block — it is repeated here for installs where 071's
// exact-match missed.
// ---------------------------------------------------------------------------

const STATIC_RELEASE_NOTE_BLOCKS: string[] = [
  `<!-- release-note-id:043-release-notes-latex-rendering -->
## LaTeX math rendering in chat

I can now render LaTeX block-math expressions in the macOS chat. Content wrapped in \`$$...$$\` is typeset instead of shown as raw monospace text. Inline \`$...$\` math is planned as a follow-up.
`,
  `<!-- release-note-id:045-release-notes-meet-avatar -->
## Meet video avatar with lip-sync (v1)

I can now appear as a video avatar during Google Meet calls, with lip-sync
driven by my TTS output. v1 uses the TalkingHead.js renderer running inside
the meet-bot container; hosted renderers (Simli, HeyGen) and GPU sidecars
(SadTalker, MuseTalk) are additive follow-ups and are not yet available.

### One-time setup (required before enabling)

The repo currently ships a placeholder \`default-avatar.glb\` at
\`skills/meet-join/meet-controller-ext/avatar/default-avatar.glb\` that is
**0 bytes** — the avatar will fail fast at enable time until you replace
it with a real Ready Player Me model. Export a \`.glb\` from Ready Player Me
and drop it at that path before turning the feature on.

### Host setup (Linux only)

The avatar publishes frames to a virtual camera via \`v4l2loopback\`. On
the Linux host that runs the assistant:

\`\`\`bash
sudo apt-get install v4l2loopback-dkms
sudo modprobe v4l2loopback video_nr=10 card_label="VellumAvatar" exclusive_caps=1
\`\`\`

macOS bare-metal is **not supported** for the avatar in v1 — the virtual
camera stack is Linux-specific.

### Enabling the avatar

In your Meet service config, set:

\`\`\`json
{
  "services": {
    "meet": {
      "avatar": { "enabled": true, "renderer": "talking-head" }
    }
  }
}
\`\`\`

**Docker mode:** the CLI automatically passes \`VELLUM_AVATAR_DEVICE\`
(default \`/dev/video10\`) to the assistant container and bind-mounts
the device node when it exists on the host.

### New tools

Two new assistant tools are available (feature-flag gated on \`meet\`):

- \`meet_enable_avatar\` — turn the avatar on for a meeting.
- \`meet_disable_avatar\` — turn the avatar off for a meeting.

Ask me to enable or disable my avatar in a Meet and I'll call these for you.
`,
  `<!-- release-note-id:049-release-notes-default-sonnet -->
## Default LLM is now Claude Sonnet 4.6 (main agent stays on Opus)

The schema-level default for \`llm.default.model\` is now
\`claude-sonnet-4-6\` instead of \`claude-opus-4-7\`, so background call
sites that fall through to the default now use Sonnet. If you've
already chosen a model, your persisted config takes precedence.

The main agent conversation loop remains on Opus: a companion
migration seeds \`llm.callSites.mainAgent = { model: "claude-opus-4-7" }\`
when it's unset, and the \`quality-optimized\` model intent also still
resolves to Opus.

To switch the main agent to Sonnet, clear the call-site override:

\`\`\`bash
assistant config unset llm.callSites.mainAgent
\`\`\`

To switch the overall default back to Opus, run:

\`\`\`bash
assistant config set llm.default.model claude-opus-4-7
\`\`\`
`,
  `<!-- release-note-id:053-release-notes-acp-codex -->
## ACP: Codex and Claude profiles + \`acp_steer\`

The assistant now ships with default ACP profiles for \`claude\` and
\`codex\`. They become available **after enabling ACP and installing the
corresponding adapter** — the profiles are wired in by default but the
underlying agent binaries are not bundled.

A new \`acp_steer\` tool lets the assistant interrupt and redirect a
running ACP session without ending it, so I can course-correct an agent
mid-task.

### Setup

1. Enable ACP in your config:

   \`\`\`bash
   assistant config set acp.enabled true
   \`\`\`

2. Install the adapter for whichever agent(s) you want to use:

   \`\`\`bash
   npm i -g @zed-industries/codex-acp
   npm i -g @agentclientprotocol/claude-agent-acp
   \`\`\`

If a required binary is missing when I try to spawn an ACP session, I'll
surface an install hint so you know which package to add.

### Known limitation (v1)

Live step-by-step progress for ACP sessions is not yet rendered in the
macOS app. The agent's final response lands in chat when it completes —
intermediate tool calls and partial output are still being plumbed
through. Live progress UI is a follow-up.
`,
  `<!-- release-note-id:055-release-notes-agentic-recall -->
## Recall can search more places now

When you ask me to recall something, I can now search across memory,
knowledge base notes, past conversations, and workspace files. That means
I can find relevant context from more of your assistant workspace without
you needing to remember where it was saved.
`,
  `<!-- release-note-id:056-release-notes-inference-profile-reordering -->
## Inference profiles can be reordered

You can now drag inference profiles into the order you want from Settings.
The same order appears anywhere you pick a profile, including the active
profile dropdown, chat profile picker, and per-call-site overrides.
`,
  `<!-- release-note-id:058-release-notes-acp-sessions-ui -->
## Coding Agents panel for Codex and Claude sessions

A new "Coding Agents" panel in the macOS app and a matching iOS surface show
running and historical Codex and Claude Code sessions with live progress.

- Inline \`Acp Spawn\` step blocks in chat are now tap-to-open and show live
  status as the agent runs.
- A per-conversation filter narrows the panel to just the agents spawned by
  the current conversation.
- Sessions persist across assistant and app restarts: completed sessions
  appear in history, and any sessions that were running when the assistant
  stopped are clearly marked as ended with the assistant.
- \`agent_thought_chunk\` reasoning is now rendered as italic secondary text
  and can be toggled on or off.
`,
  `<!-- release-note-id:063-release-notes-dynamic-model-context -->
## Model-aware inference profile limits

Inference profiles now show max output tokens as a model-aware slider, so the
available range follows the selected model instead of accepting invalid values.

You can also configure the context window per profile. New managed profiles
stay at the conservative 200K context budget by default, and existing profiles
keep their current effective context budget unless you edit them.
`,
  `<!-- release-note-id:067-release-notes-safe-storage-limits -->
## Safe storage limits

A new storage protection mode is available behind the safe-storage-limits
rollout flag. When enabled, the assistant watches workspace disk usage and
enters cleanup mode if the volume reaches the critical 95% threshold.

In cleanup mode, background processes pause and remote messages, including
trusted-contact messages, are blocked until the guardian frees enough space or
explicitly overrides the lock. The macOS app now shows a storage cleanup banner
that must be acknowledged before cleanup chat continues, then keeps a status
banner visible while cleanup mode is active.
`,
  `<!-- release-note-id:068-release-notes-local-timezone -->
## Local timezone grounding

The assistant now grounds \`current_time\` in your local timezone across clients,
instead of falling back to UTC when the client can report the device timezone.

Manual timezone overrides still win when configured, and the assistant can help
update a stale override after you confirm that your device timezone should be
used going forward.
`,
  `<!-- release-note-id:078-release-notes-tavily-web-search -->
## Tavily web search

Tavily is now available as a web search provider. Add your Tavily API key in
Settings → Models & Services, or run \`assistant keys set tavily <key>\`, then
select Tavily for Web Search.
`,
];

// ---------------------------------------------------------------------------
// 074-drop-deprecated-secret-detection-keys interpolated the user's previous
// `secretDetection.action` value into its notice, so it is matched with a
// single-wildcard pattern instead of an exact string. The two halves mirror
// `buildNotice()` in that migration verbatim.
// ---------------------------------------------------------------------------

const NOTICE_074_BEFORE_ACTION = `<!-- release-note-id:074-drop-deprecated-secret-detection-keys -->
## Heads-up: tool-output secret scanning was retired

Your previous \`secretDetection.action\` setting was \`"`;

const NOTICE_074_AFTER_ACTION = `"\`,
which used to gate or redact tool output containing high-entropy strings or
matches against custom regex patterns. That post-execution scanning layer has
been removed because it was false-positive prone and prevented the assistant
from acting on values it had legitimately fetched.

Prefix-based ingress detection on user messages is still active
(\`secretDetection.enabled\` / \`secretDetection.blockIngress\`), and the
\`secretDetection.entropyThreshold\` and \`secretDetection.customPatterns\`
fields have been removed from your config. If you relied on the old behavior,
please reach out so we can find a better solution for your use case.
`;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const DYNAMIC_RELEASE_NOTE_PATTERNS: RegExp[] = [
  new RegExp(
    escapeRegExp(NOTICE_074_BEFORE_ACTION) +
      '[^"]*' +
      escapeRegExp(NOTICE_074_AFTER_ACTION),
    "g",
  ),
];

/**
 * Remove every known release-note block from `content`. Unmatched text —
 * user-authored notes, config-quarantine notes, hand-edited blocks — is
 * preserved. Surrounding blank lines left by removals are collapsed.
 */
function stripKnownReleaseNoteBlocks(content: string): string {
  let remaining = content;
  for (const block of STATIC_RELEASE_NOTE_BLOCKS) {
    remaining = remaining.split(block).join("\n");
  }
  for (const pattern of DYNAMIC_RELEASE_NOTE_PATTERNS) {
    remaining = remaining.replace(pattern, "\n");
  }
  return remaining.replace(/\n{3,}/g, "\n\n").replace(/^\n+/, "");
}

export const removeStaleUpdatesBulletinFileMigration: WorkspaceMigration = {
  id: MIGRATION_ID,
  description:
    "Remove stale UPDATES.md release-note bulletins (processing job removed)",

  run(workspaceDir: string): void {
    const updatesPath = join(workspaceDir, "UPDATES.md");
    if (!existsSync(updatesPath)) {
      return;
    }

    const content = readFileSync(updatesPath, "utf-8");
    const cleaned = stripKnownReleaseNoteBlocks(content);

    if (cleaned.trim() === "") {
      rmSync(updatesPath, { force: true });
      return;
    }

    if (cleaned !== content) {
      writeFileSync(updatesPath, cleaned, "utf-8");
    }
  },

  down(_workspaceDir: string): void {
    // Forward-only: the removed content was pending release-note bulletins
    // for a feature that no longer exists.
  },
};
