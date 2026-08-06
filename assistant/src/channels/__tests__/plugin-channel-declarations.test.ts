/**
 * Channels declared by installed plugins.
 *
 * `getWorkspacePluginsDir` is mocked to a scratch directory so these read real
 * files off disk without touching the machine's workspace.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

const workspacePluginsDir = mkdtempSync(join(tmpdir(), "plugin-channels-"));

const realPlatform = await import("../../util/platform.js");

mock.module("../../util/platform.js", () => ({
  ...realPlatform,
  getWorkspacePluginsDir: () => workspacePluginsDir,
}));

const { discoverPluginChannels } =
  await import("../plugin-channel-declarations.js");

const DECLARATION = {
  label: "iMessage",
  subtitle: "Reach the assistant by text.",
  icon: "message-circle",
};

function writePlugin(name: string, declaration?: unknown): string {
  const dir = join(workspacePluginsDir, name);
  mkdirSync(join(dir, "channels"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name }));
  if (declaration !== undefined) {
    writeFileSync(
      join(dir, "channels", "channel.json"),
      typeof declaration === "string"
        ? declaration
        : JSON.stringify(declaration),
    );
  }
  return dir;
}

beforeEach(() => {
  rmSync(workspacePluginsDir, { recursive: true, force: true });
  mkdirSync(workspacePluginsDir, { recursive: true });
});

afterAll(() => {
  rmSync(workspacePluginsDir, { recursive: true, force: true });
});

describe("discoverPluginChannels", () => {
  test("reports a declaration under an id namespaced by its plugin", () => {
    writePlugin("imessage", DECLARATION);

    expect(discoverPluginChannels().channels).toEqual([
      {
        id: "plugin:imessage",
        plugin: "imessage",
        ...DECLARATION,
      },
    ]);
  });

  test("takes the plugin identity from the directory, not the file", () => {
    // Otherwise a manifest could claim to be another plugin's channel, and
    // the id is what a client keys settings and routing off.
    writePlugin("imessage", { ...DECLARATION, plugin: "slack" });

    // `plugin` is not a declared field, so claiming one fails the manifest
    // outright rather than being quietly ignored.
    const { channels, problems } = discoverPluginChannels();
    expect(channels).toEqual([]);
    expect(problems[0]!.plugin).toBe("imessage");
  });

  test("ignores a plugin that declares no channel", () => {
    // Most plugins are not channels. Absence is the normal case, not a fault.
    writePlugin("notes");

    expect(discoverPluginChannels()).toEqual({ channels: [], problems: [] });
  });

  test("skips a disabled plugin", () => {
    // Same source of truth the loader uses for hooks, tools and routes: a
    // disabled plugin would otherwise offer a setup flow that cannot run.
    const dir = writePlugin("imessage", DECLARATION);
    writeFileSync(join(dir, ".disabled"), "");

    expect(discoverPluginChannels().channels).toEqual([]);
  });

  test("reports a malformed declaration without hiding its siblings", () => {
    // One plugin's broken file must not cost every other plugin its channel.
    writePlugin("broken", "{ not json");
    writePlugin("imessage", DECLARATION);

    const { channels, problems } = discoverPluginChannels();
    expect(channels.map((c) => c.plugin)).toEqual(["imessage"]);
    expect(problems).toEqual([
      { plugin: "broken", reason: "unreadable or malformed JSON" },
    ]);
  });

  test("refuses an icon that is not a bare lucide name", () => {
    // Clients resolve it by concatenation (`lucide-${icon}`), so anything
    // else renders as a missing glyph rather than failing visibly.
    writePlugin("imessage", { ...DECLARATION, icon: "lucide-message-circle" });

    const { channels, problems } = discoverPluginChannels();
    expect(channels).toEqual([]);
    expect(problems[0]!.reason).toContain("icon");
  });

  test("refuses a field it does not define", () => {
    // The manifest is strict, so a typo or an invented key is reported
    // rather than silently doing nothing.
    writePlugin("imessage", { ...DECLARATION, app: "imessage-settings" });

    expect(discoverPluginChannels().channels).toEqual([]);
  });
});
