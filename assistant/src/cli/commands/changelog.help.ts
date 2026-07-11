/** Declarative help for the `assistant changelog` command. */

import type { CliCommandHelp } from "../lib/cli-command-help.js";

// Shared config surfaced in the help text; `changelog.ts` imports these for
// the fetch/cache behavior so the prose can never drift from the code.
export const REPO = "vellum-ai/vellum-assistant";
export const LIST_TTL_MS = 60 * 60 * 1000;
export const DEFAULT_LIST_LIMIT = 30;
/**
 * Maximum number of stable releases we persist in the rolling `recent` slot.
 * Most callers only ever read the latest one or two; capping the cache keeps
 * the file small and the network round-trip predictable.
 */
export const CACHE_STABLE_LIMIT = 5;

export const changelogHelp: CliCommandHelp = {
  name: "changelog",
  description:
    "Show release notes of the Vellum Assistant to see what new capabilities you have!",
  options: [
    {
      flags: "--since <version>",
      description:
        "Show notes for every stable release newer than this version (e.g. 0.7.0)",
    },
    { flags: "--no-cache", description: "Bypass the local cache" },
    { flags: "--json", description: "Output structured JSON" },
    {
      flags: "--limit <n>",
      description: "Max releases to consider when listing or filtering (1-100)",
      defaultValue: String(DEFAULT_LIST_LIMIT),
    },
  ],
  helpText: `
Release notes are fetched on demand from the public GitHub Releases of
${REPO}. The most recent ${CACHE_STABLE_LIMIT} stable releases are cached
locally for ${LIST_TTL_MS / 60_000} minutes; pass --no-cache to bypass.
Specific tags are cached indefinitely once seen because release tags are
immutable.

Examples:
  $ assistant changelog                       Show the latest release
  $ assistant changelog --since 0.7.0         Show every release since 0.7.0
  $ assistant changelog show 0.8.0            Show a specific release
  $ assistant changelog list                  List recent release tags
  $ assistant changelog --json                JSON output for tooling`,
  subcommands: [
    {
      name: "show",
      args: "<version>",
      description: "Show release notes for a specific version tag",
    },
    {
      name: "list",
      description: "List recent release tags",
    },
  ],
};
