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
// ── browser ────────────────────────────────────────────────────────────────────
import * as browserClick from "./bundled-skills/browser/tools/browser-click.js";
import * as browserClose from "./bundled-skills/browser/tools/browser-close.js";
import * as browserExtract from "./bundled-skills/browser/tools/browser-extract.js";
import * as browserFillCredential from "./bundled-skills/browser/tools/browser-fill-credential.js";
import * as browserHover from "./bundled-skills/browser/tools/browser-hover.js";
import * as browserNavigate from "./bundled-skills/browser/tools/browser-navigate.js";
import * as browserPressKey from "./bundled-skills/browser/tools/browser-press-key.js";
import * as browserScreenshot from "./bundled-skills/browser/tools/browser-screenshot.js";
import * as browserScroll from "./bundled-skills/browser/tools/browser-scroll.js";
import * as browserSelectOption from "./bundled-skills/browser/tools/browser-select-option.js";
import * as browserSnapshot from "./bundled-skills/browser/tools/browser-snapshot.js";
import * as browserType from "./bundled-skills/browser/tools/browser-type.js";
import * as browserWaitFor from "./bundled-skills/browser/tools/browser-wait-for.js";
import * as browserWaitForDownload from "./bundled-skills/browser/tools/browser-wait-for-download.js";
// ── chatgpt-import ─────────────────────────────────────────────────────────────
import * as chatgptImport from "./bundled-skills/chatgpt-import/tools/chatgpt-import.js";
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
// ── document ───────────────────────────────────────────────────────────────────
import * as documentCreate from "./bundled-skills/document/tools/document-create.js";
import * as documentUpdate from "./bundled-skills/document/tools/document-update.js";
// ── followups ──────────────────────────────────────────────────────────────────
import * as followupCreate from "./bundled-skills/followups/tools/followup-create.js";
import * as followupList from "./bundled-skills/followups/tools/followup-list.js";
import * as followupResolve from "./bundled-skills/followups/tools/followup-resolve.js";
// ── gmail ──────────────────────────────────────────────────────────────────────
import * as gmailArchive from "./bundled-skills/gmail/tools/gmail-archive.js";
import * as gmailAttachments from "./bundled-skills/gmail/tools/gmail-attachments.js";
import * as gmailDraft from "./bundled-skills/gmail/tools/gmail-draft.js";
import * as gmailFilters from "./bundled-skills/gmail/tools/gmail-filters.js";
import * as gmailFollowUp from "./bundled-skills/gmail/tools/gmail-follow-up.js";
import * as gmailForward from "./bundled-skills/gmail/tools/gmail-forward.js";
import * as gmailLabel from "./bundled-skills/gmail/tools/gmail-label.js";
import * as gmailOutreachScan from "./bundled-skills/gmail/tools/gmail-outreach-scan.js";
import * as gmailSendDraft from "./bundled-skills/gmail/tools/gmail-send-draft.js";
import * as gmailSenderDigest from "./bundled-skills/gmail/tools/gmail-sender-digest.js";
import * as gmailTrash from "./bundled-skills/gmail/tools/gmail-trash.js";
import * as gmailUnsubscribe from "./bundled-skills/gmail/tools/gmail-unsubscribe.js";
import * as gmailVacation from "./bundled-skills/gmail/tools/gmail-vacation.js";
// ── google-calendar ────────────────────────────────────────────────────────────
import * as calendarCheckAvailability from "./bundled-skills/google-calendar/tools/calendar-check-availability.js";
import * as calendarCreateEvent from "./bundled-skills/google-calendar/tools/calendar-create-event.js";
import * as calendarGetEvent from "./bundled-skills/google-calendar/tools/calendar-get-event.js";
import * as calendarListEvents from "./bundled-skills/google-calendar/tools/calendar-list-events.js";
import * as calendarRsvp from "./bundled-skills/google-calendar/tools/calendar-rsvp.js";
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
// ── orchestration ──────────────────────────────────────────────────────────────
import * as swarmDelegate from "./bundled-skills/orchestration/tools/swarm-delegate.js";
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
import * as navigateSettingsTab from "./bundled-skills/settings/tools/navigate-settings-tab.js";
import * as openSystemSettings from "./bundled-skills/settings/tools/open-system-settings.js";
import * as voiceConfigUpdate from "./bundled-skills/settings/tools/voice-config-update.js";
// ── skill-management ───────────────────────────────────────────────────────────
import * as deleteManaged from "./bundled-skills/skill-management/tools/delete-managed.js";
import * as scaffoldManaged from "./bundled-skills/skill-management/tools/scaffold-managed.js";
// ── slack ──────────────────────────────────────────────────────────────────────
import * as slackAddReaction from "./bundled-skills/slack/tools/slack-add-reaction.js";
import * as slackChannelDetails from "./bundled-skills/slack/tools/slack-channel-details.js";
import * as slackChannelPermissions from "./bundled-skills/slack/tools/slack-channel-permissions.js";
import * as slackConfigureChannels from "./bundled-skills/slack/tools/slack-configure-channels.js";
import * as slackDeleteMessage from "./bundled-skills/slack/tools/slack-delete-message.js";
import * as slackEditMessage from "./bundled-skills/slack/tools/slack-edit-message.js";
import * as slackLeaveChannel from "./bundled-skills/slack/tools/slack-leave-channel.js";
import * as slackScanDigest from "./bundled-skills/slack/tools/slack-scan-digest.js";
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

  // browser
  ["browser:tools/browser-navigate.ts", browserNavigate],
  ["browser:tools/browser-snapshot.ts", browserSnapshot],
  ["browser:tools/browser-screenshot.ts", browserScreenshot],
  ["browser:tools/browser-close.ts", browserClose],
  ["browser:tools/browser-click.ts", browserClick],
  ["browser:tools/browser-type.ts", browserType],
  ["browser:tools/browser-press-key.ts", browserPressKey],
  ["browser:tools/browser-scroll.ts", browserScroll],
  ["browser:tools/browser-select-option.ts", browserSelectOption],
  ["browser:tools/browser-hover.ts", browserHover],
  ["browser:tools/browser-wait-for.ts", browserWaitFor],
  ["browser:tools/browser-extract.ts", browserExtract],
  ["browser:tools/browser-wait-for-download.ts", browserWaitForDownload],
  ["browser:tools/browser-fill-credential.ts", browserFillCredential],

  // chatgpt-import
  ["chatgpt-import:tools/chatgpt-import.ts", chatgptImport],

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

  // document
  ["document:tools/document-create.ts", documentCreate],
  ["document:tools/document-update.ts", documentUpdate],

  // followups
  ["followups:tools/followup-create.ts", followupCreate],
  ["followups:tools/followup-list.ts", followupList],
  ["followups:tools/followup-resolve.ts", followupResolve],

  // gmail
  ["gmail:tools/gmail-archive.ts", gmailArchive],
  ["gmail:tools/gmail-label.ts", gmailLabel],
  ["gmail:tools/gmail-trash.ts", gmailTrash],
  ["gmail:tools/gmail-unsubscribe.ts", gmailUnsubscribe],
  ["gmail:tools/gmail-draft.ts", gmailDraft],
  ["gmail:tools/gmail-send-draft.ts", gmailSendDraft],
  ["gmail:tools/gmail-attachments.ts", gmailAttachments],
  ["gmail:tools/gmail-forward.ts", gmailForward],
  ["gmail:tools/gmail-follow-up.ts", gmailFollowUp],
  ["gmail:tools/gmail-filters.ts", gmailFilters],
  ["gmail:tools/gmail-vacation.ts", gmailVacation],
  ["gmail:tools/gmail-sender-digest.ts", gmailSenderDigest],
  ["gmail:tools/gmail-outreach-scan.ts", gmailOutreachScan],

  // google-calendar
  ["google-calendar:tools/calendar-list-events.ts", calendarListEvents],
  ["google-calendar:tools/calendar-get-event.ts", calendarGetEvent],
  ["google-calendar:tools/calendar-create-event.ts", calendarCreateEvent],
  [
    "google-calendar:tools/calendar-check-availability.ts",
    calendarCheckAvailability,
  ],
  ["google-calendar:tools/calendar-rsvp.ts", calendarRsvp],

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

  // orchestration
  ["orchestration:tools/swarm-delegate.ts", swarmDelegate],

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

  // skill-management
  ["skill-management:tools/scaffold-managed.ts", scaffoldManaged],
  ["skill-management:tools/delete-managed.ts", deleteManaged],

  // slack
  ["slack:tools/slack-scan-digest.ts", slackScanDigest],
  ["slack:tools/slack-channel-details.ts", slackChannelDetails],
  ["slack:tools/slack-configure-channels.ts", slackConfigureChannels],
  ["slack:tools/slack-add-reaction.ts", slackAddReaction],
  ["slack:tools/slack-delete-message.ts", slackDeleteMessage],
  ["slack:tools/slack-edit-message.ts", slackEditMessage],
  ["slack:tools/slack-leave-channel.ts", slackLeaveChannel],
  ["slack:tools/slack-channel-permissions.ts", slackChannelPermissions],

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
