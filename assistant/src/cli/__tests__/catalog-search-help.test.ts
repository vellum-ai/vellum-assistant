/**
 * Memory injection indexes CLI help via {@link buildCliCommandHelpContent}.
 * Setup prompts like "Setup <app> for me" should retrieve `plugins search` /
 * `skills search` before the model falls back to web search.
 *
 * These assertions lock the retrieval phrases in the indexed blob so a later
 * wording change cannot silently drop them.
 */
import { describe, expect, test } from "bun:test";

import { buildCliCommandHelpContent } from "../../plugins/defaults/memory/substrate/cli-command-content.js";
import { pluginsHelp } from "../commands/plugins.help.js";
import { skillsHelp } from "../commands/skills.help.js";

function searchHelp(
  help: { subcommands?: Array<{ name: string; helpText?: string }> },
): { name: string; helpText?: string } {
  const search = help.subcommands?.find((sub) => sub.name === "search");
  if (!search) {
    throw new Error("expected a search subcommand");
  }
  return search;
}

describe("catalog search help for setup-intent retrieval", () => {
  test("plugins help indexes setup, superpowers, and web-search fallback", () => {
    const indexed = buildCliCommandHelpContent(pluginsHelp);
    const search = searchHelp(pluginsHelp);

    expect(search.helpText).toBeDefined();
    expect(indexed.toLowerCase()).toContain("superpowers");
    expect(indexed).toContain("Setup <app> for me");
    expect(indexed.toLowerCase()).toContain("before searching the web");
    expect(indexed).toContain("assistant plugins search");
    expect(indexed).toContain("assistant skills search");
    expect(indexed.toLowerCase()).not.toContain("empty query");
  });

  test("skills help indexes setup as the second stop before web search", () => {
    const indexed = buildCliCommandHelpContent(skillsHelp);
    const search = searchHelp(skillsHelp);

    expect(search.helpText).toBeDefined();
    expect(indexed).toContain("Second stop after plugin search");
    expect(indexed).toContain("Setup <app> for me");
    expect(indexed.toLowerCase()).toContain("before searching the web");
    expect(indexed).toContain("assistant skills search");
    expect(indexed).toContain("try web search");
  });
});
