/**
 * Auto-generated registry of bundled skill tool scripts.
 *
 * In compiled Bun binaries, bundled tool scripts can't be dynamically
 * imported from the filesystem because their relative imports point to
 * modules that only exist inside the binary's virtual /$bunfs/ filesystem.
 *
 * This registry eagerly imports every bundled tool script so it becomes
 * part of the compiled binary.  At runtime, the skill-script-runner
 * checks this map before falling back to a dynamic import.
 *
 * Regenerate with:
 *   bun run scripts/generate-bundled-tool-registry.ts
 */
import type { SkillToolScript } from "../tools/skills/script-contract.js";
// ── acp ────────────────────────────────────────────────────────────────────────
import * as acpAbort from "./bundled-skills/acp/tools/acp-abort.js";
import * as acpSpawn from "./bundled-skills/acp/tools/acp-spawn.js";
import * as acpStatus from "./bundled-skills/acp/tools/acp-status.js";
// ── app-builder ────────────────────────────────────────────────────────────────
import * as appCreate from "./bundled-skills/app-builder/tools/app-create.js";
import * as appDelete from "./bundled-skills/app-builder/tools/app-delete.js";
import * as appGenerateIcon from "./bundled-skills/app-builder/tools/app-generate-icon.js";
import * as appRefresh from "./bundled-skills/app-builder/tools/app-refresh.js";
// ── computer-use ───────────────────────────────────────────────────────────────
import * as computerUseClick from "./bundled-skills/computer-use/tools/computer-use-click.js";
import * as computerUseDone from "./bundled-skills/computer-use/tools/computer-use-done.js";
import * as computerUseDrag from "./bundled-skills/computer-use/tools/computer-use-drag.js";
import * as computerUseKey from "./bundled-skills/computer-use/tools/computer-use-key.js";
import * as computerUseObserve from "./bundled-skills/computer-use/tools/computer-use-observe.js";
import * as computerUseOpenApp from "./bundled-skills/computer-use/tools/computer-use-open-app.js";
import * as computerUseRespond from "./bundled-skills/computer-use/tools/computer-use-respond.js";
import * as computerUseRunApplescript from "./bundled-skills/computer-use/tools/computer-use-run-applescript.js";
import * as computerUseScroll from "./bundled-skills/computer-use/tools/computer-use-scroll.js";
import * as computerUseTypeText from "./bundled-skills/computer-use/tools/computer-use-type-text.js";
import * as computerUseWait from "./bundled-skills/computer-use/tools/computer-use-wait.js";
// ── contacts ───────────────────────────────────────────────────────────────────
import * as contactMerge from "./bundled-skills/contacts/tools/contact-merge.js";
import * as contactSearch from "./bundled-skills/contacts/tools/contact-search.js";
import * as contactUpsert from "./bundled-skills/contacts/tools/contact-upsert.js";
import * as googleContacts from "./bundled-skills/contacts/tools/google-contacts.js";
// ── conversations ──────────────────────────────────────────────────────────────
import * as renameConversation from "./bundled-skills/conversations/tools/rename-conversation.js";
// ── document ───────────────────────────────────────────────────────────────────
import * as documentCreate from "./bundled-skills/document/tools/document-create.js";
import * as documentUpdate from "./bundled-skills/document/tools/document-update.js";
// ── followups ──────────────────────────────────────────────────────────────────
import * as followupCreate from "./bundled-skills/followups/tools/followup-create.js";
import * as followupList from "./bundled-skills/followups/tools/followup-list.js";
import * as followupResolve from "./bundled-skills/followups/tools/followup-resolve.js";
// ── image-studio ───────────────────────────────────────────────────────────────
import * as mediaGenerateImage from "./bundled-skills/image-studio/tools/media-generate-image.js";
// ── media-processing ───────────────────────────────────────────────────────────
import * as analyzeKeyframes from "./bundled-skills/media-processing/tools/analyze-keyframes.js";
import * as extractKeyframes from "./bundled-skills/media-processing/tools/extract-keyframes.js";
import * as generateClip from "./bundled-skills/media-processing/tools/generate-clip.js";
import * as ingestMedia from "./bundled-skills/media-processing/tools/ingest-media.js";
import * as mediaStatus from "./bundled-skills/media-processing/tools/media-status.js";
import * as queryMediaEvents from "./bundled-skills/media-processing/tools/query-media-events.js";
// ── messaging ──────────────────────────────────────────────────────────────────
import * as messagingAnalyzeStyle from "./bundled-skills/messaging/tools/messaging-analyze-style.js";
import * as messagingArchiveBySender from "./bundled-skills/messaging/tools/messaging-archive-by-sender.js";
import * as messagingAuthTest from "./bundled-skills/messaging/tools/messaging-auth-test.js";
import * as messagingDraft from "./bundled-skills/messaging/tools/messaging-draft.js";
import * as messagingListConversations from "./bundled-skills/messaging/tools/messaging-list-conversations.js";
import * as messagingMarkRead from "./bundled-skills/messaging/tools/messaging-mark-read.js";
import * as messagingRead from "./bundled-skills/messaging/tools/messaging-read.js";
import * as messagingSearch from "./bundled-skills/messaging/tools/messaging-search.js";
import * as messagingSend from "./bundled-skills/messaging/tools/messaging-send.js";
import * as messagingSenderDigest from "./bundled-skills/messaging/tools/messaging-sender-digest.js";
// ── notifications ──────────────────────────────────────────────────────────────
import * as sendNotification from "./bundled-skills/notifications/tools/send-notification.js";
// ── phone-calls ────────────────────────────────────────────────────────────────
import * as callEnd from "./bundled-skills/phone-calls/tools/call-end.js";
import * as callStart from "./bundled-skills/phone-calls/tools/call-start.js";
import * as callStatus from "./bundled-skills/phone-calls/tools/call-status.js";
// ── playbooks ──────────────────────────────────────────────────────────────────
import * as playbookCreate from "./bundled-skills/playbooks/tools/playbook-create.js";
import * as playbookDelete from "./bundled-skills/playbooks/tools/playbook-delete.js";
import * as playbookList from "./bundled-skills/playbooks/tools/playbook-list.js";
import * as playbookUpdate from "./bundled-skills/playbooks/tools/playbook-update.js";
// ── schedule ───────────────────────────────────────────────────────────────────
import * as scheduleCreate from "./bundled-skills/schedule/tools/schedule-create.js";
import * as scheduleDelete from "./bundled-skills/schedule/tools/schedule-delete.js";
import * as scheduleList from "./bundled-skills/schedule/tools/schedule-list.js";
import * as scheduleUpdate from "./bundled-skills/schedule/tools/schedule-update.js";
// ── screen-watch ───────────────────────────────────────────────────────────────
import * as startScreenWatch from "./bundled-skills/screen-watch/tools/start-screen-watch.js";
// ── sequences ──────────────────────────────────────────────────────────────────
import * as sequenceAnalytics from "./bundled-skills/sequences/tools/sequence-analytics.js";
import * as sequenceCreate from "./bundled-skills/sequences/tools/sequence-create.js";
import * as sequenceDelete from "./bundled-skills/sequences/tools/sequence-delete.js";
import * as sequenceEnroll from "./bundled-skills/sequences/tools/sequence-enroll.js";
import * as sequenceEnrollmentList from "./bundled-skills/sequences/tools/sequence-enrollment-list.js";
import * as sequenceGet from "./bundled-skills/sequences/tools/sequence-get.js";
import * as sequenceImport from "./bundled-skills/sequences/tools/sequence-import.js";
import * as sequenceList from "./bundled-skills/sequences/tools/sequence-list.js";
import * as sequenceUpdate from "./bundled-skills/sequences/tools/sequence-update.js";
// ── settings ───────────────────────────────────────────────────────────────────
import * as avatarGet from "./bundled-skills/settings/tools/avatar-get.js";
import * as avatarRemove from "./bundled-skills/settings/tools/avatar-remove.js";
import * as avatarUpdate from "./bundled-skills/settings/tools/avatar-update.js";
import * as navigateSettingsTab from "./bundled-skills/settings/tools/navigate-settings-tab.js";
import * as openSystemSettings from "./bundled-skills/settings/tools/open-system-settings.js";
import * as voiceConfigUpdate from "./bundled-skills/settings/tools/voice-config-update.js";
// ── skill-management ───────────────────────────────────────────────────────────
import * as deleteManaged from "./bundled-skills/skill-management/tools/delete-managed.js";
import * as scaffoldManaged from "./bundled-skills/skill-management/tools/scaffold-managed.js";
// ── subagent ───────────────────────────────────────────────────────────────────
import * as subagentAbort from "./bundled-skills/subagent/tools/subagent-abort.js";
import * as subagentMessage from "./bundled-skills/subagent/tools/subagent-message.js";
import * as subagentRead from "./bundled-skills/subagent/tools/subagent-read.js";
import * as subagentSpawn from "./bundled-skills/subagent/tools/subagent-spawn.js";
import * as subagentStatus from "./bundled-skills/subagent/tools/subagent-status.js";
// ── tasks ──────────────────────────────────────────────────────────────────────
import * as taskDelete from "./bundled-skills/tasks/tools/task-delete.js";
import * as taskList from "./bundled-skills/tasks/tools/task-list.js";
import * as taskListAdd from "./bundled-skills/tasks/tools/task-list-add.js";
import * as taskListRemove from "./bundled-skills/tasks/tools/task-list-remove.js";
import * as taskListShow from "./bundled-skills/tasks/tools/task-list-show.js";
import * as taskListUpdate from "./bundled-skills/tasks/tools/task-list-update.js";
import * as taskQueueRun from "./bundled-skills/tasks/tools/task-queue-run.js";
import * as taskRun from "./bundled-skills/tasks/tools/task-run.js";
import * as taskSave from "./bundled-skills/tasks/tools/task-save.js";
// ── transcribe ─────────────────────────────────────────────────────────────────
import * as transcribeMedia from "./bundled-skills/transcribe/tools/transcribe-media.js";
// ── watcher ────────────────────────────────────────────────────────────────────
import * as watcherCreate from "./bundled-skills/watcher/tools/watcher-create.js";
import * as watcherDelete from "./bundled-skills/watcher/tools/watcher-delete.js";
import * as watcherDigest from "./bundled-skills/watcher/tools/watcher-digest.js";
import * as watcherList from "./bundled-skills/watcher/tools/watcher-list.js";
import * as watcherUpdate from "./bundled-skills/watcher/tools/watcher-update.js";

// ─── Registry ────────────────────────────────────────────────────────────────

/** Key format: `skillDirBasename:executorPath` (e.g. `schedule:tools/schedule-list.ts`). */
export const bundledToolRegistry = new Map<string, SkillToolScript>([
  // acp
  ["acp:tools/acp-spawn.ts", acpSpawn],
  ["acp:tools/acp-status.ts", acpStatus],
  ["acp:tools/acp-abort.ts", acpAbort],

  // app-builder
  ["app-builder:tools/app-create.ts", appCreate],
  ["app-builder:tools/app-delete.ts", appDelete],
  ["app-builder:tools/app-refresh.ts", appRefresh],
  ["app-builder:tools/app-generate-icon.ts", appGenerateIcon],

  // computer-use
  ["computer-use:tools/computer-use-observe.ts", computerUseObserve],
  ["computer-use:tools/computer-use-click.ts", computerUseClick],
  ["computer-use:tools/computer-use-type-text.ts", computerUseTypeText],
  ["computer-use:tools/computer-use-key.ts", computerUseKey],
  ["computer-use:tools/computer-use-scroll.ts", computerUseScroll],
  ["computer-use:tools/computer-use-drag.ts", computerUseDrag],
  ["computer-use:tools/computer-use-wait.ts", computerUseWait],
  ["computer-use:tools/computer-use-open-app.ts", computerUseOpenApp],
  [
    "computer-use:tools/computer-use-run-applescript.ts",
    computerUseRunApplescript,
  ],
  ["computer-use:tools/computer-use-done.ts", computerUseDone],
  ["computer-use:tools/computer-use-respond.ts", computerUseRespond],

  // contacts
  ["contacts:tools/contact-upsert.ts", contactUpsert],
  ["contacts:tools/contact-search.ts", contactSearch],
  ["contacts:tools/contact-merge.ts", contactMerge],
  ["contacts:tools/google-contacts.ts", googleContacts],

  // conversations
  ["conversations:tools/rename-conversation.ts", renameConversation],

  // document
  ["document:tools/document-create.ts", documentCreate],
  ["document:tools/document-update.ts", documentUpdate],

  // followups
  ["followups:tools/followup-create.ts", followupCreate],
  ["followups:tools/followup-list.ts", followupList],
  ["followups:tools/followup-resolve.ts", followupResolve],

  // image-studio
  ["image-studio:tools/media-generate-image.ts", mediaGenerateImage],

  // media-processing
  ["media-processing:tools/ingest-media.ts", ingestMedia],
  ["media-processing:tools/media-status.ts", mediaStatus],
  ["media-processing:tools/extract-keyframes.ts", extractKeyframes],
  ["media-processing:tools/analyze-keyframes.ts", analyzeKeyframes],
  ["media-processing:tools/query-media-events.ts", queryMediaEvents],
  ["media-processing:tools/generate-clip.ts", generateClip],

  // messaging
  ["messaging:tools/messaging-auth-test.ts", messagingAuthTest],
  [
    "messaging:tools/messaging-list-conversations.ts",
    messagingListConversations,
  ],
  ["messaging:tools/messaging-read.ts", messagingRead],
  ["messaging:tools/messaging-search.ts", messagingSearch],
  ["messaging:tools/messaging-send.ts", messagingSend],
  ["messaging:tools/messaging-mark-read.ts", messagingMarkRead],
  ["messaging:tools/messaging-analyze-style.ts", messagingAnalyzeStyle],
  ["messaging:tools/messaging-draft.ts", messagingDraft],
  ["messaging:tools/messaging-sender-digest.ts", messagingSenderDigest],
  ["messaging:tools/messaging-archive-by-sender.ts", messagingArchiveBySender],

  // notifications
  ["notifications:tools/send-notification.ts", sendNotification],

  // phone-calls
  ["phone-calls:tools/call-start.ts", callStart],
  ["phone-calls:tools/call-status.ts", callStatus],
  ["phone-calls:tools/call-end.ts", callEnd],

  // playbooks
  ["playbooks:tools/playbook-create.ts", playbookCreate],
  ["playbooks:tools/playbook-list.ts", playbookList],
  ["playbooks:tools/playbook-update.ts", playbookUpdate],
  ["playbooks:tools/playbook-delete.ts", playbookDelete],

  // schedule
  ["schedule:tools/schedule-create.ts", scheduleCreate],
  ["schedule:tools/schedule-list.ts", scheduleList],
  ["schedule:tools/schedule-update.ts", scheduleUpdate],
  ["schedule:tools/schedule-delete.ts", scheduleDelete],

  // screen-watch
  ["screen-watch:tools/start-screen-watch.ts", startScreenWatch],

  // sequences
  ["sequences:tools/sequence-create.ts", sequenceCreate],
  ["sequences:tools/sequence-list.ts", sequenceList],
  ["sequences:tools/sequence-get.ts", sequenceGet],
  ["sequences:tools/sequence-update.ts", sequenceUpdate],
  ["sequences:tools/sequence-delete.ts", sequenceDelete],
  ["sequences:tools/sequence-enroll.ts", sequenceEnroll],
  ["sequences:tools/sequence-enrollment-list.ts", sequenceEnrollmentList],
  ["sequences:tools/sequence-import.ts", sequenceImport],
  ["sequences:tools/sequence-analytics.ts", sequenceAnalytics],

  // settings
  ["settings:tools/voice-config-update.ts", voiceConfigUpdate],
  ["settings:tools/open-system-settings.ts", openSystemSettings],
  ["settings:tools/navigate-settings-tab.ts", navigateSettingsTab],
  ["settings:tools/avatar-update.ts", avatarUpdate],
  ["settings:tools/avatar-remove.ts", avatarRemove],
  ["settings:tools/avatar-get.ts", avatarGet],

  // skill-management
  ["skill-management:tools/scaffold-managed.ts", scaffoldManaged],
  ["skill-management:tools/delete-managed.ts", deleteManaged],

  // subagent
  ["subagent:tools/subagent-spawn.ts", subagentSpawn],
  ["subagent:tools/subagent-status.ts", subagentStatus],
  ["subagent:tools/subagent-abort.ts", subagentAbort],
  ["subagent:tools/subagent-message.ts", subagentMessage],
  ["subagent:tools/subagent-read.ts", subagentRead],

  // tasks
  ["tasks:tools/task-save.ts", taskSave],
  ["tasks:tools/task-run.ts", taskRun],
  ["tasks:tools/task-list.ts", taskList],
  ["tasks:tools/task-delete.ts", taskDelete],
  ["tasks:tools/task-list-show.ts", taskListShow],
  ["tasks:tools/task-list-add.ts", taskListAdd],
  ["tasks:tools/task-list-update.ts", taskListUpdate],
  ["tasks:tools/task-list-remove.ts", taskListRemove],
  ["tasks:tools/task-queue-run.ts", taskQueueRun],

  // transcribe
  ["transcribe:tools/transcribe-media.ts", transcribeMedia],

  // watcher
  ["watcher:tools/watcher-create.ts", watcherCreate],
  ["watcher:tools/watcher-list.ts", watcherList],
  ["watcher:tools/watcher-update.ts", watcherUpdate],
  ["watcher:tools/watcher-delete.ts", watcherDelete],
  ["watcher:tools/watcher-digest.ts", watcherDigest],
]);
