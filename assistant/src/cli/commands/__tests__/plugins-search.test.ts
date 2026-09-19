/**
 * Tests for `assistant plugins search` human vs `--json` output.
 *
 * Search results include a `github:owner/repo@ref` PATH column. The model
 * copies that locator into `plugins install`. The human footer tells it to
 * install by marketplace name instead.
 */

import { describe, expect, mock, test } from "bun:test";

import type { GetPluginCatalogOptions } from "../../lib/plugin-catalog-cache.js";
import { PLUGINS_SEARCH_INSTALL_HINT } from "../plugins.help.js";
import { runCliCommand } from "./cli-test-harness.js";

const catalog = {
  ref: "test-ref",
  matches: [
    {
      name: "imessage",
      path: "github:vellum-ai/imessage@abc123",
      category: "productivity",
      source: {
        kind: "github" as const,
        repo: "vellum-ai/imessage",
        ref: "abc123",
      },
    },
  ],
};

/** Read options each `getPluginCatalog` call was made with, newest last. */
const catalogReadOptions: (GetPluginCatalogOptions | undefined)[] = [];

mock.module("../../lib/plugin-catalog-cache.js", () => ({
  getPluginCatalog: async (
    _ref: string,
    _deps: unknown,
    options?: GetPluginCatalogOptions,
  ) => {
    catalogReadOptions.push(options);
    return catalog;
  },
}));

const { registerPluginsCommand } = await import("../plugins.js");

function runSearch(args: string[]): Promise<{
  stdout: string;
  exitCode: number;
}> {
  return runCliCommand(registerPluginsCommand, ["plugins", ...args]);
}

describe("plugins search", () => {
  test("reads the catalog fresh: a one-shot CLI has no warm cache to serve", async () => {
    await runSearch(["search", "imessage"]);

    expect(catalogReadOptions.at(-1)).toEqual({ fresh: true });
  });

  test("human output ends with the marketplace-name install hint", async () => {
    const { exitCode, stdout } = await runSearch(["search", "imessage"]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("imessage");
    expect(stdout).toContain("github:vellum-ai/imessage@abc123");
    expect(stdout).toContain('1 match for "imessage".');
    expect(stdout.trimEnd().endsWith(PLUGINS_SEARCH_INSTALL_HINT)).toBe(true);
    expect(PLUGINS_SEARCH_INSTALL_HINT).toContain(
      "assistant plugins install <name>",
    );
  });

  test("empty human result has no install hint", async () => {
    const { exitCode, stdout } = await runSearch(["search", "nothing-matches"]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain('No plugins matched "nothing-matches".');
    expect(stdout).not.toContain(PLUGINS_SEARCH_INSTALL_HINT);
  });

  test("json output omits the install hint", async () => {
    const { exitCode, stdout } = await runSearch([
      "search",
      "imessage",
      "--json",
    ]);

    expect(exitCode).toBe(0);
    expect(stdout).not.toContain(PLUGINS_SEARCH_INSTALL_HINT);
    const parsed = JSON.parse(stdout) as {
      query: string;
      matches: Array<{ name: string }>;
    };
    expect(parsed.query).toBe("imessage");
    expect(parsed.matches.map((m) => m.name)).toEqual(["imessage"]);
  });
});
