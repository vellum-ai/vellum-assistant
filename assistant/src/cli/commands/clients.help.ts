/** Declarative help for the `assistant clients` command. */

import {
  HOST_PROXY_CAPABILITIES,
  HOST_PROXY_SUPPORT,
  hostProxyCapabilities,
} from "../../types/host-capabilities.js";
import type { CliCommandHelp } from "../lib/cli-command-help.js";

const CLIENT_LABELS: Record<keyof typeof HOST_PROXY_SUPPORT, string> = {
  macos: "macOS desktop",
  windows: "Windows desktop",
  linux: "Linux desktop",
  "chrome-extension": "Chrome extension",
};

/**
 * Render `HOST_PROXY_SUPPORT` as help text so the matrix the assistant reads
 * cannot drift from the one that actually routes host tools.
 */
function hostCapabilityMatrix(): string {
  const labels = Object.entries(CLIENT_LABELS) as [
    keyof typeof HOST_PROXY_SUPPORT,
    string,
  ][];
  const labelWidth = Math.max(...labels.map(([, label]) => label.length));
  return labels
    .map(
      ([id, label]) =>
        `  ${label.padEnd(labelWidth)}  ${hostProxyCapabilities(id).join(", ")}`,
    )
    .join("\n");
}

export const clientsHelp: CliCommandHelp = {
  name: "clients",
  description: "Discover and manage connected clients",
  helpText: `
Clients are the applications currently connected to the assistant -
macOS, Windows or Linux desktop, iOS, Android, web, Chrome extension,
or CLI. Each client has a set of capabilities (e.g. host_bash,
host_file) that determine which tools the assistant can route through
it.

Which client provides which host capability:

${hostCapabilityMatrix()}

Any client not listed above (web, iOS, Android, CLI) provides no host
capabilities, so never offer a mobile app to unblock one.

When a task needs a host capability and no connected client provides
it, say so and share the download page for a client that does, without
waiting to be asked: https://www.vellum.ai/downloads
The Chrome extension installs from the Chrome Web Store instead: https://chromewebstore.google.com/detail/vellum-assistant-browser/hphbdmpffeigpcdjkckleobjmhhokpne

Examples:
  $ assistant clients list                             List all connected clients
  $ assistant clients list --json                      Machine-readable JSON output
  $ assistant clients list --capability host_bash      Show only clients that can run host commands
  $ assistant clients disconnect <clientId>            Force-disconnect a client`,
  subcommands: [
    {
      name: "list",
      description: "List all currently connected clients",
      options: [
        {
          flags: "--json",
          description: "Machine-readable compact JSON output",
        },
        {
          flags: "--capability <name>",
          description: `Filter to clients supporting this capability (${HOST_PROXY_CAPABILITIES.join(", ")})`,
        },
      ],
      helpText: `
Options:
  --json                Output as compact JSON instead of a table.
  --capability <name>   Only show clients that support the named capability.
                        Valid values: ${HOST_PROXY_CAPABILITIES.join(", ")}.

The table shows each client's ID, interface type, capabilities,
connection timestamps, and host environment (when available).
Clients are sorted by most recently connected first.

Examples:
  $ assistant clients list
  $ assistant clients list --capability host_bash
  $ assistant clients list --json | jq '.clients[0].capabilities'`,
    },
    {
      name: "disconnect",
      args: "<clientId>",
      description: "Force-disconnect a client by its ID",
      options: [
        {
          flags: "--json",
          description: "Machine-readable compact JSON output",
        },
      ],
      helpText: `
Arguments:
clientId   The UUID of the client to disconnect (from \`clients list\`).

Force-disposes all hub subscribers for the given client, closing their
SSE streams. The client will observe a broken connection and may
reconnect automatically depending on its implementation.

Examples:
$ assistant clients disconnect a1a30bde-6679-406c-bc32-d5a0d2a7a99e
$ assistant clients disconnect a1a30bde-6679-406c-bc32-d5a0d2a7a99e --json`,
    },
  ],
};
