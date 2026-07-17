/**
 * Aggregated declarative help for the top-level `assistant` CLI commands that
 * have adopted the static-help split (`<command>.help.ts`).
 *
 * Plugins — notably the memory capability indexer — import this to read command
 * help without importing `cli/program.ts`, which pulls every command's action
 * handler (and its daemon/IPC deps) into the import graph. Entries are pure data
 * (see {@link ./lib/cli-command-help.CliCommandHelp}); consumers iterate them.
 *
 * Extend this as commands adopt the split. Once every command is listed here,
 * the memory indexer no longer needs `buildCliProgramTree()`.
 */

import { appsHelp } from "./commands/apps.help.js";
import { attachmentHelp } from "./commands/attachment.help.js";
import { auditHelp } from "./commands/audit.help.js";
import { authHelp } from "./commands/auth.help.js";
import { avatarHelp } from "./commands/avatar.help.js";
import { backupHelp } from "./commands/backup.help.js";
import { bashHelp } from "./commands/bash.help.js";
import { browserHelp } from "./commands/browser.help.js";
import { cacheHelp } from "./commands/cache.help.js";
import { changelogHelp } from "./commands/changelog.help.js";
import { channelVerificationSessionsHelp } from "./commands/channel-verification-sessions.help.js";
import { channelsHelp } from "./commands/channels/index.help.js";
import { clientsHelp } from "./commands/clients.help.js";
import { completionsHelp } from "./commands/completions.help.js";
import { configHelp } from "./commands/config.help.js";
import { contactsHelp } from "./commands/contacts.help.js";
import { conversationsHelp } from "./commands/conversations.help.js";
import { credentialsHelp } from "./commands/credentials.help.js";
import { dbHelp } from "./commands/db/index.help.js";
import { domainHelp } from "./commands/domain.help.js";
import { emailHelp } from "./commands/email.help.js";
import { gatewayHelp } from "./commands/gateway.help.js";
import { imageGenerationHelp } from "./commands/image-generation.help.js";
import { inferenceHelp, llmHelp } from "./commands/inference.help.js";
import { keysHelp } from "./commands/keys.help.js";
import { mcpHelp } from "./commands/mcp.help.js";
import { memoryHelp } from "./commands/memory/index.help.js";
import { monitoringHelp } from "./commands/monitoring.help.js";
import { notificationsHelp } from "./commands/notifications.help.js";
import { oauthHelp } from "./commands/oauth/index.help.js";
import { pendingHelp } from "./commands/pending.help.js";
import { platformHelp } from "./commands/platform/index.help.js";
import { pluginsHelp } from "./commands/plugins.help.js";
import { psHelp } from "./commands/ps.help.js";
import { routesHelp } from "./commands/routes.help.js";
import { schedulesHelp } from "./commands/schedules.help.js";
import { sequenceHelp } from "./commands/sequence.help.js";
import { skillsHelp } from "./commands/skills.help.js";
import { statusHelp } from "./commands/status.help.js";
import { sttHelp } from "./commands/stt.help.js";
import { telemetryHelp } from "./commands/telemetry.help.js";
import { toolsHelp } from "./commands/tools.help.js";
import { trustHelp } from "./commands/trust.help.js";
import { ttsHelp } from "./commands/tts.help.js";
import { uiHelp } from "./commands/ui.help.js";
import { usageHelp } from "./commands/usage.help.js";
import { watchersHelp } from "./commands/watchers.help.js";
import { webhooksHelp } from "./commands/webhooks.help.js";
import type { CliCommandHelp } from "./lib/cli-command-help.js";

export const CLI_COMMAND_HELP: readonly CliCommandHelp[] = [
  appsHelp,
  attachmentHelp,
  auditHelp,
  authHelp,
  avatarHelp,
  backupHelp,
  bashHelp,
  browserHelp,
  cacheHelp,
  changelogHelp,
  channelVerificationSessionsHelp,
  channelsHelp,
  clientsHelp,
  completionsHelp,
  configHelp,
  contactsHelp,
  conversationsHelp,
  credentialsHelp,
  dbHelp,
  domainHelp,
  emailHelp,
  gatewayHelp,
  imageGenerationHelp,
  inferenceHelp,
  keysHelp,
  llmHelp,
  mcpHelp,
  memoryHelp,
  notificationsHelp,
  oauthHelp,
  pendingHelp,
  platformHelp,
  pluginsHelp,
  monitoringHelp,
  psHelp,
  routesHelp,
  schedulesHelp,
  sequenceHelp,
  skillsHelp,
  statusHelp,
  sttHelp,
  telemetryHelp,
  toolsHelp,
  trustHelp,
  ttsHelp,
  uiHelp,
  usageHelp,
  watchersHelp,
  webhooksHelp,
];
