import { describe, expect, test } from "bun:test";

import { roadmapHelp } from "../roadmap.help.js";

const DISCORD_URL = "https://vellum.ai/community";

const HELP_CONTEXTS = [
  { name: "roadmap", help: roadmapHelp },
  {
    name: "create",
    help: roadmapHelp.subcommands?.find((command) => command.name === "create"),
  },
] as const;

describe("roadmap help is feature-proposal-only", () => {
  test.each(HELP_CONTEXTS)(
    "$name help describes feature proposals and routes bugs to Discord",
    ({ help }) => {
      expect(help).toBeDefined();
      const description = help?.description ?? "";
      const helpText = help?.helpText ?? "";
      const combined = `${description}\n${helpText}`.toLowerCase();

      expect(combined).toMatch(/feature proposals?/);
      expect(description.split(DISCORD_URL)).toHaveLength(2);
      expect(helpText).toContain(DISCORD_URL);
      expect(combined).not.toMatch(/support@|github\.com|share feedback/);
    },
  );
});
