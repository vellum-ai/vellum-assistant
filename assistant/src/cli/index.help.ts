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
import type { CliCommandHelp } from "./lib/cli-command-help.js";

export const CLI_COMMAND_HELP: readonly CliCommandHelp[] = [
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
];
