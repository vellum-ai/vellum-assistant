/** Declarative help for the `assistant plugin-skill` command. */

import type { CliCommandHelp } from "../lib/cli-command-help.js";

export const pluginSkillHelp: CliCommandHelp = {
  name: "plugin-skill",
  description:
    "Run a script from an active plugin-resident skill with that plugin's credential scope",
  helpText: `
Run companion scripts shipped under an installed plugin's
skills/<skill>/scripts/ or skills/<skill>/tools/ directory.

The assistant looks up the skill in the catalog and copies the plugin
owner from trusted install metadata. A caller cannot supply a plugin
name, path, or environment value to claim a different identity.

The script runs as a child of the assistant. It may call
resolveCredential() from @vellumai/plugin-api for credentials under the
owning plugin's service only (for install slug "sms", that is sms/*).

Do not invoke plugin skill scripts with raw bun or bash. Those children
do not receive plugin identity or credential authority.

Examples:
  $ assistant plugin-skill run sms-setup scripts/twilio-numbers.ts list
  $ assistant plugin-skill run demo-skill scripts/resolve.ts demo-skill/api_key
`,
  subcommands: [
    {
      name: "run",
      description:
        "Execute a plugin-resident skill script for the current conversation",
      arguments: [
        {
          name: "<skill-id>",
          description:
            "Catalog id of the plugin-resident skill (directory name under skills/)",
        },
        {
          name: "<script>",
          description:
            "Path relative to the skill directory, under scripts/ or tools/",
        },
        {
          name: "[script-args...]",
          description: "Arguments forwarded to the script",
        },
      ],
      options: [
        {
          flags: "--conversation-id <id>",
          description:
            "Conversation that has the skill active. Defaults to the enclosing tool-shell conversation.",
        },
        {
          flags: "--timeout <ms>",
          description: "Maximum time to wait for the script",
          defaultValue: "30000",
        },
      ],
      helpText: `
The skill must be active in the conversation. Workspace skills and
bundled skills are rejected: they are not plugin-owned.

The script path must stay under the skill's scripts/ or tools/
directory. Parent-directory segments and absolute paths are rejected.

Examples:
  $ assistant plugin-skill run sms-setup scripts/twilio-numbers.ts list
  $ assistant plugin-skill run demo-skill scripts/resolve.ts demo-skill/api_key
`,
    },
  ],
};
