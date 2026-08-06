/** Declarative help for the `assistant domain` command. */

import type { CliCommandHelp } from "../lib/cli-command-help.js";

export const domainHelp: CliCommandHelp = {
  name: "domain",
  description: "Register and manage this assistant's custom subdomain",
  options: [
    {
      flags: "--json",
      description: "Machine-readable compact JSON output",
    },
  ],
  subcommands: [
    {
      name: "register",
      args: "[subdomain]",
      description: "Register a custom subdomain for this assistant",
      options: [
        {
          flags: "--email-username <username>",
          description:
            "Also register an email address (e.g. --email-username hello → hello@<subdomain>.domain)",
        },
      ],
    },
    {
      name: "status",
      args: "<subdomain>",
      description:
        "Show registration and DNS verification status for a subdomain",
    },
  ],
};
