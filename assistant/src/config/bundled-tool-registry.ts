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
import type { SkillToolScript } from '../tools/skills/script-contract.js';

// ── app-builder ──────────────────────────────────────────────────────────────
import * as appCreate from './bundled-skills/app-builder/tools/app-create.js';
import * as appList from './bundled-skills/app-builder/tools/app-list.js';
import * as appQuery from './bundled-skills/app-builder/tools/app-query.js';
import * as appUpdate from './bundled-skills/app-builder/tools/app-update.js';
import * as appDelete from './bundled-skills/app-builder/tools/app-delete.js';
import * as appFileList from './bundled-skills/app-builder/tools/app-file-list.js';
import * as appFileRead from './bundled-skills/app-builder/tools/app-file-read.js';
import * as appFileEdit from './bundled-skills/app-builder/tools/app-file-edit.js';
import * as appFileWrite from './bundled-skills/app-builder/tools/app-file-write.js';

// ── browser ──────────────────────────────────────────────────────────────────
import * as browserNavigate from './bundled-skills/browser/tools/browser-navigate.js';
import * as browserSnapshot from './bundled-skills/browser/tools/browser-snapshot.js';
import * as browserScreenshot from './bundled-skills/browser/tools/browser-screenshot.js';
import * as browserClose from './bundled-skills/browser/tools/browser-close.js';
import * as browserClick from './bundled-skills/browser/tools/browser-click.js';
import * as browserType from './bundled-skills/browser/tools/browser-type.js';
import * as browserPressKey from './bundled-skills/browser/tools/browser-press-key.js';
import * as browserWaitFor from './bundled-skills/browser/tools/browser-wait-for.js';
import * as browserExtract from './bundled-skills/browser/tools/browser-extract.js';
import * as browserFillCredential from './bundled-skills/browser/tools/browser-fill-credential.js';

// ── claude-code ──────────────────────────────────────────────────────────────
import * as claudeCode from './bundled-skills/claude-code/tools/claude-code.js';

// ── computer-use ─────────────────────────────────────────────────────────────
import * as computerUseClick from './bundled-skills/computer-use/tools/computer-use-click.js';
import * as computerUseDoubleClick from './bundled-skills/computer-use/tools/computer-use-double-click.js';
import * as computerUseRightClick from './bundled-skills/computer-use/tools/computer-use-right-click.js';
import * as computerUseTypeText from './bundled-skills/computer-use/tools/computer-use-type-text.js';
import * as computerUseKey from './bundled-skills/computer-use/tools/computer-use-key.js';
import * as computerUseScroll from './bundled-skills/computer-use/tools/computer-use-scroll.js';
import * as computerUseDrag from './bundled-skills/computer-use/tools/computer-use-drag.js';
import * as computerUseWait from './bundled-skills/computer-use/tools/computer-use-wait.js';
import * as computerUseOpenApp from './bundled-skills/computer-use/tools/computer-use-open-app.js';
import * as computerUseRunApplescript from './bundled-skills/computer-use/tools/computer-use-run-applescript.js';
import * as computerUseDone from './bundled-skills/computer-use/tools/computer-use-done.js';
import * as computerUseRespond from './bundled-skills/computer-use/tools/computer-use-respond.js';

// ── contacts ─────────────────────────────────────────────────────────────────
import * as contactUpsert from './bundled-skills/contacts/tools/contact-upsert.js';
import * as contactSearch from './bundled-skills/contacts/tools/contact-search.js';
import * as contactMerge from './bundled-skills/contacts/tools/contact-merge.js';

// ── document ─────────────────────────────────────────────────────────────────
import * as documentCreate from './bundled-skills/document/tools/document-create.js';
import * as documentUpdate from './bundled-skills/document/tools/document-update.js';

// ── followups ────────────────────────────────────────────────────────────────
import * as followupCreate from './bundled-skills/followups/tools/followup-create.js';
import * as followupList from './bundled-skills/followups/tools/followup-list.js';
import * as followupResolve from './bundled-skills/followups/tools/followup-resolve.js';

// ── google-calendar ──────────────────────────────────────────────────────────
import * as calendarListEvents from './bundled-skills/google-calendar/tools/calendar-list-events.js';
import * as calendarGetEvent from './bundled-skills/google-calendar/tools/calendar-get-event.js';
import * as calendarCreateEvent from './bundled-skills/google-calendar/tools/calendar-create-event.js';
import * as calendarCheckAvailability from './bundled-skills/google-calendar/tools/calendar-check-availability.js';
import * as calendarRsvp from './bundled-skills/google-calendar/tools/calendar-rsvp.js';

// ── image-studio ─────────────────────────────────────────────────────────────
import * as mediaGenerateImage from './bundled-skills/image-studio/tools/media-generate-image.js';

// ── knowledge-graph ──────────────────────────────────────────────────────────
import * as graphQuery from './bundled-skills/knowledge-graph/tools/graph-query.js';

// ── media-processing ─────────────────────────────────────────────────────────
import * as ingestMedia from './bundled-skills/media-processing/tools/ingest-media.js';
import * as mediaStatus from './bundled-skills/media-processing/tools/media-status.js';
import * as extractKeyframes from './bundled-skills/media-processing/tools/extract-keyframes.js';
import * as analyzeKeyframes from './bundled-skills/media-processing/tools/analyze-keyframes.js';
import * as detectEvents from './bundled-skills/media-processing/tools/detect-events.js';
import * as queryMediaEvents from './bundled-skills/media-processing/tools/query-media-events.js';
import * as selectTrackingProfile from './bundled-skills/media-processing/tools/select-tracking-profile.js';
import * as generateClip from './bundled-skills/media-processing/tools/generate-clip.js';
import * as submitFeedback from './bundled-skills/media-processing/tools/submit-feedback.js';
import * as mediaDiagnostics from './bundled-skills/media-processing/tools/media-diagnostics.js';
import * as recalibrate from './bundled-skills/media-processing/tools/recalibrate.js';

// ── messaging ────────────────────────────────────────────────────────────────
import * as messagingAuthTest from './bundled-skills/messaging/tools/messaging-auth-test.js';
import * as messagingListConversations from './bundled-skills/messaging/tools/messaging-list-conversations.js';
import * as messagingRead from './bundled-skills/messaging/tools/messaging-read.js';
import * as messagingSearch from './bundled-skills/messaging/tools/messaging-search.js';
import * as messagingSend from './bundled-skills/messaging/tools/messaging-send.js';
import * as messagingReply from './bundled-skills/messaging/tools/messaging-reply.js';
import * as messagingMarkRead from './bundled-skills/messaging/tools/messaging-mark-read.js';
import * as slackAddReaction from './bundled-skills/messaging/tools/slack-add-reaction.js';
import * as slackLeaveChannel from './bundled-skills/messaging/tools/slack-leave-channel.js';
import * as messagingAnalyzeActivity from './bundled-skills/messaging/tools/messaging-analyze-activity.js';
import * as messagingAnalyzeStyle from './bundled-skills/messaging/tools/messaging-analyze-style.js';
import * as messagingDraft from './bundled-skills/messaging/tools/messaging-draft.js';
import * as gmailArchive from './bundled-skills/messaging/tools/gmail-archive.js';
import * as gmailBatchArchive from './bundled-skills/messaging/tools/gmail-batch-archive.js';
import * as gmailLabel from './bundled-skills/messaging/tools/gmail-label.js';
import * as gmailBatchLabel from './bundled-skills/messaging/tools/gmail-batch-label.js';
import * as gmailTrash from './bundled-skills/messaging/tools/gmail-trash.js';
import * as gmailUnsubscribe from './bundled-skills/messaging/tools/gmail-unsubscribe.js';
import * as gmailDraft from './bundled-skills/messaging/tools/gmail-draft.js';

// ── playbooks ────────────────────────────────────────────────────────────────
import * as playbookCreate from './bundled-skills/playbooks/tools/playbook-create.js';
import * as playbookList from './bundled-skills/playbooks/tools/playbook-list.js';
import * as playbookUpdate from './bundled-skills/playbooks/tools/playbook-update.js';
import * as playbookDelete from './bundled-skills/playbooks/tools/playbook-delete.js';

// ── reminder ─────────────────────────────────────────────────────────────────
import * as reminderCreate from './bundled-skills/reminder/tools/reminder-create.js';
import * as reminderList from './bundled-skills/reminder/tools/reminder-list.js';
import * as reminderCancel from './bundled-skills/reminder/tools/reminder-cancel.js';

// ── schedule ─────────────────────────────────────────────────────────────────
import * as scheduleCreate from './bundled-skills/schedule/tools/schedule-create.js';
import * as scheduleList from './bundled-skills/schedule/tools/schedule-list.js';
import * as scheduleUpdate from './bundled-skills/schedule/tools/schedule-update.js';
import * as scheduleDelete from './bundled-skills/schedule/tools/schedule-delete.js';

// ── subagent ─────────────────────────────────────────────────────────────────
import * as subagentSpawn from './bundled-skills/subagent/tools/subagent-spawn.js';
import * as subagentStatus from './bundled-skills/subagent/tools/subagent-status.js';
import * as subagentAbort from './bundled-skills/subagent/tools/subagent-abort.js';
import * as subagentMessage from './bundled-skills/subagent/tools/subagent-message.js';
import * as subagentRead from './bundled-skills/subagent/tools/subagent-read.js';

// ── tasks ────────────────────────────────────────────────────────────────────
import * as taskSave from './bundled-skills/tasks/tools/task-save.js';
import * as taskRun from './bundled-skills/tasks/tools/task-run.js';
import * as taskList from './bundled-skills/tasks/tools/task-list.js';
import * as taskDelete from './bundled-skills/tasks/tools/task-delete.js';
import * as taskListShow from './bundled-skills/tasks/tools/task-list-show.js';
import * as taskListAdd from './bundled-skills/tasks/tools/task-list-add.js';
import * as taskListUpdate from './bundled-skills/tasks/tools/task-list-update.js';
import * as taskListRemove from './bundled-skills/tasks/tools/task-list-remove.js';
import * as taskQueueRun from './bundled-skills/tasks/tools/task-queue-run.js';

// ── transcribe ───────────────────────────────────────────────────────────────
import * as transcribeMedia from './bundled-skills/transcribe/tools/transcribe-media.js';

// ── watcher ──────────────────────────────────────────────────────────────────
import * as watcherCreate from './bundled-skills/watcher/tools/watcher-create.js';
import * as watcherList from './bundled-skills/watcher/tools/watcher-list.js';
import * as watcherUpdate from './bundled-skills/watcher/tools/watcher-update.js';
import * as watcherDelete from './bundled-skills/watcher/tools/watcher-delete.js';
import * as watcherDigest from './bundled-skills/watcher/tools/watcher-digest.js';

// ── weather ──────────────────────────────────────────────────────────────────
import * as getWeather from './bundled-skills/weather/tools/get-weather.js';

// ─── Registry ────────────────────────────────────────────────────────────────

/** Key format: `skillDirBasename:executorPath` (e.g. `schedule:tools/schedule-list.ts`). */
export const bundledToolRegistry = new Map<string, SkillToolScript>([
  // app-builder
  ['app-builder:tools/app-create.ts', appCreate],
  ['app-builder:tools/app-list.ts', appList],
  ['app-builder:tools/app-query.ts', appQuery],
  ['app-builder:tools/app-update.ts', appUpdate],
  ['app-builder:tools/app-delete.ts', appDelete],
  ['app-builder:tools/app-file-list.ts', appFileList],
  ['app-builder:tools/app-file-read.ts', appFileRead],
  ['app-builder:tools/app-file-edit.ts', appFileEdit],
  ['app-builder:tools/app-file-write.ts', appFileWrite],

  // browser
  ['browser:tools/browser-navigate.ts', browserNavigate],
  ['browser:tools/browser-snapshot.ts', browserSnapshot],
  ['browser:tools/browser-screenshot.ts', browserScreenshot],
  ['browser:tools/browser-close.ts', browserClose],
  ['browser:tools/browser-click.ts', browserClick],
  ['browser:tools/browser-type.ts', browserType],
  ['browser:tools/browser-press-key.ts', browserPressKey],
  ['browser:tools/browser-wait-for.ts', browserWaitFor],
  ['browser:tools/browser-extract.ts', browserExtract],
  ['browser:tools/browser-fill-credential.ts', browserFillCredential],

  // claude-code
  ['claude-code:tools/claude-code.ts', claudeCode],

  // computer-use
  ['computer-use:tools/computer-use-click.ts', computerUseClick],
  ['computer-use:tools/computer-use-double-click.ts', computerUseDoubleClick],
  ['computer-use:tools/computer-use-right-click.ts', computerUseRightClick],
  ['computer-use:tools/computer-use-type-text.ts', computerUseTypeText],
  ['computer-use:tools/computer-use-key.ts', computerUseKey],
  ['computer-use:tools/computer-use-scroll.ts', computerUseScroll],
  ['computer-use:tools/computer-use-drag.ts', computerUseDrag],
  ['computer-use:tools/computer-use-wait.ts', computerUseWait],
  ['computer-use:tools/computer-use-open-app.ts', computerUseOpenApp],
  ['computer-use:tools/computer-use-run-applescript.ts', computerUseRunApplescript],
  ['computer-use:tools/computer-use-done.ts', computerUseDone],
  ['computer-use:tools/computer-use-respond.ts', computerUseRespond],

  // contacts
  ['contacts:tools/contact-upsert.ts', contactUpsert],
  ['contacts:tools/contact-search.ts', contactSearch],
  ['contacts:tools/contact-merge.ts', contactMerge],

  // document
  ['document:tools/document-create.ts', documentCreate],
  ['document:tools/document-update.ts', documentUpdate],

  // followups
  ['followups:tools/followup-create.ts', followupCreate],
  ['followups:tools/followup-list.ts', followupList],
  ['followups:tools/followup-resolve.ts', followupResolve],

  // google-calendar
  ['google-calendar:tools/calendar-list-events.ts', calendarListEvents],
  ['google-calendar:tools/calendar-get-event.ts', calendarGetEvent],
  ['google-calendar:tools/calendar-create-event.ts', calendarCreateEvent],
  ['google-calendar:tools/calendar-check-availability.ts', calendarCheckAvailability],
  ['google-calendar:tools/calendar-rsvp.ts', calendarRsvp],

  // image-studio
  ['image-studio:tools/media-generate-image.ts', mediaGenerateImage],

  // knowledge-graph
  ['knowledge-graph:tools/graph-query.ts', graphQuery],

  // media-processing
  ['media-processing:tools/ingest-media.ts', ingestMedia],
  ['media-processing:tools/media-status.ts', mediaStatus],
  ['media-processing:tools/extract-keyframes.ts', extractKeyframes],
  ['media-processing:tools/analyze-keyframes.ts', analyzeKeyframes],
  ['media-processing:tools/detect-events.ts', detectEvents],
  ['media-processing:tools/query-media-events.ts', queryMediaEvents],
  ['media-processing:tools/select-tracking-profile.ts', selectTrackingProfile],
  ['media-processing:tools/generate-clip.ts', generateClip],
  ['media-processing:tools/submit-feedback.ts', submitFeedback],
  ['media-processing:tools/media-diagnostics.ts', mediaDiagnostics],
  ['media-processing:tools/recalibrate.ts', recalibrate],

  // messaging
  ['messaging:tools/messaging-auth-test.ts', messagingAuthTest],
  ['messaging:tools/messaging-list-conversations.ts', messagingListConversations],
  ['messaging:tools/messaging-read.ts', messagingRead],
  ['messaging:tools/messaging-search.ts', messagingSearch],
  ['messaging:tools/messaging-send.ts', messagingSend],
  ['messaging:tools/messaging-reply.ts', messagingReply],
  ['messaging:tools/messaging-mark-read.ts', messagingMarkRead],
  ['messaging:tools/slack-add-reaction.ts', slackAddReaction],
  ['messaging:tools/slack-leave-channel.ts', slackLeaveChannel],
  ['messaging:tools/messaging-analyze-activity.ts', messagingAnalyzeActivity],
  ['messaging:tools/messaging-analyze-style.ts', messagingAnalyzeStyle],
  ['messaging:tools/messaging-draft.ts', messagingDraft],
  ['messaging:tools/gmail-archive.ts', gmailArchive],
  ['messaging:tools/gmail-batch-archive.ts', gmailBatchArchive],
  ['messaging:tools/gmail-label.ts', gmailLabel],
  ['messaging:tools/gmail-batch-label.ts', gmailBatchLabel],
  ['messaging:tools/gmail-trash.ts', gmailTrash],
  ['messaging:tools/gmail-unsubscribe.ts', gmailUnsubscribe],
  ['messaging:tools/gmail-draft.ts', gmailDraft],

  // playbooks
  ['playbooks:tools/playbook-create.ts', playbookCreate],
  ['playbooks:tools/playbook-list.ts', playbookList],
  ['playbooks:tools/playbook-update.ts', playbookUpdate],
  ['playbooks:tools/playbook-delete.ts', playbookDelete],

  // reminder
  ['reminder:tools/reminder-create.ts', reminderCreate],
  ['reminder:tools/reminder-list.ts', reminderList],
  ['reminder:tools/reminder-cancel.ts', reminderCancel],

  // schedule
  ['schedule:tools/schedule-create.ts', scheduleCreate],
  ['schedule:tools/schedule-list.ts', scheduleList],
  ['schedule:tools/schedule-update.ts', scheduleUpdate],
  ['schedule:tools/schedule-delete.ts', scheduleDelete],

  // subagent
  ['subagent:tools/subagent-spawn.ts', subagentSpawn],
  ['subagent:tools/subagent-status.ts', subagentStatus],
  ['subagent:tools/subagent-abort.ts', subagentAbort],
  ['subagent:tools/subagent-message.ts', subagentMessage],
  ['subagent:tools/subagent-read.ts', subagentRead],

  // tasks
  ['tasks:tools/task-save.ts', taskSave],
  ['tasks:tools/task-run.ts', taskRun],
  ['tasks:tools/task-list.ts', taskList],
  ['tasks:tools/task-delete.ts', taskDelete],
  ['tasks:tools/task-list-show.ts', taskListShow],
  ['tasks:tools/task-list-add.ts', taskListAdd],
  ['tasks:tools/task-list-update.ts', taskListUpdate],
  ['tasks:tools/task-list-remove.ts', taskListRemove],
  ['tasks:tools/task-queue-run.ts', taskQueueRun],

  // transcribe
  ['transcribe:tools/transcribe-media.ts', transcribeMedia],

  // watcher
  ['watcher:tools/watcher-create.ts', watcherCreate],
  ['watcher:tools/watcher-list.ts', watcherList],
  ['watcher:tools/watcher-update.ts', watcherUpdate],
  ['watcher:tools/watcher-delete.ts', watcherDelete],
  ['watcher:tools/watcher-digest.ts', watcherDigest],

  // weather
  ['weather:tools/get-weather.ts', getWeather],
]);
