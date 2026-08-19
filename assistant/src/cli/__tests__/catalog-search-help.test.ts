/**
 * Memory injection indexes CLI help via {@link buildCliCommandHelpContent}
 * (full help) and surfaces {@link buildCliCommandSummary} (top-level
 * description). Setup prompts like "Setup Natural for me" should retrieve
 * `plugins search` / `skills search` before the model falls back to web search.
 *
 * These assertions lock the retrieval phrases in the indexed blob and the
 * injected summary so a later wording change cannot silently drop them.
 */
import { describe, expect, test } from "bun:test";

import { buildCliCommandHelpContent } from "../../plugins/defaults/memory/substrate/cli-command-content.js";
import { pluginsHelp } from "../commands/plugins.help.js";
import { skillsHelp } from "../commands/skills.help.js";

function searchHelp(help: { subcommands?: Array<{ name: string }> }) {
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

    expect(pluginsHelp.description.toLowerCase()).toContain("superpowers");
    expect(pluginsHelp.description.toLowerCase()).toContain("set up");
    expect(pluginsHelp.description.toLowerCase()).toContain(
      "before searching the web",
    );

    expect(search.description.toLowerCase()).toContain("superpowers");
    expect(search.description.toLowerCase()).toContain("set up");
    expect(search.description.toLowerCase()).toContain("web search");

    expect(indexed).toContain("Setup Natural for me");
    expect(indexed.toLowerCase()).toContain("superpowers");
    expect(indexed.toLowerCase()).toContain("before searching the web");
    expect(indexed).toContain("assistant plugins search natural");
    expect(indexed).toContain("assistant skills search");
  });

  test("skills help indexes setup, superpowers, and web-search fallback", () => {
    const indexed = buildCliCommandHelpContent(skillsHelp);
    const search = searchHelp(skillsHelp);

    expect(skillsHelp.description.toLowerCase()).toContain("superpowers");
    expect(skillsHelp.description.toLowerCase()).toContain("set up");
    expect(skillsHelp.description.toLowerCase()).toContain(
      "before searching the web",
    );

    expect(search.description.toLowerCase()).toContain("superpowers");
    expect(search.description.toLowerCase()).toContain("set up");
    expect(search.description.toLowerCase()).toContain("web search");

    expect(indexed).toContain("Setup Natural for me");
    expect(indexed.toLowerCase()).toContain("superpowers");
    expect(indexed.toLowerCase()).toContain("before searching the web");
    expect(indexed).toContain("assistant skills search natural");
    expect(indexed).toContain("assistant plugins search");
  });
});
