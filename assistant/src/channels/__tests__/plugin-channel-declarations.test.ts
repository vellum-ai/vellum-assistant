/**
 * Channels that installed plugins bring.
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

const { discoverPluginChannels } = await import(
  "../plugin-channel-declarations.js"
);

interface PluginOptions {
  /** Contents of `channels/ingress.json`; omit for a plugin with no ingress. */
  ingress?: string;
  manifest?: Record<string, unknown>;
}

const INGRESS = JSON.stringify({
  routes: [{ path: "events", kind: "http", description: "inbound" }],
});

function writePlugin(name: string, options: PluginOptions = {}): string {
  const dir = join(workspacePluginsDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name, ...options.manifest }),
  );
  if (options.ingress !== undefined) {
    mkdirSync(join(dir, "channels"), { recursive: true });
    writeFileSync(join(dir, "channels", "ingress.json"), options.ingress);
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
  test("a plugin is a channel because it declares ingress", async () => {
    writePlugin("imessage", {
      ingress: INGRESS,
      manifest: {
        displayName: "iMessage",
        description: "Reach the assistant by text.",
        icon: "message-circle",
      },
    });

    expect(await discoverPluginChannels()).toEqual([
      {
        id: "plugin:imessage",
        plugin: "imessage",
        label: "iMessage",
        description: "Reach the assistant by text.",
        icon: "message-circle",
      },
    ]);
  });

  test("ignores a plugin that declares no ingress", async () => {
    // Presentation alone does not make a channel: reaching the assistant from
    // outside is what one is, and ingress is where that is declared.
    writePlugin("notes", {
      manifest: { displayName: "Notes", icon: "message-circle" },
    });

    expect(await discoverPluginChannels()).toEqual([]);
  });

  test("surfaces a channel whose ingress the gateway would reject", async () => {
    // Validation belongs to the gateway, which owns the schema. A plugin with
    // a broken declaration is a channel with broken ingress, and saying so
    // beats dropping it off the page the guardian would look at.
    writePlugin("imessage", {
      ingress: "{ not json",
      manifest: { displayName: "iMessage" },
    });

    expect((await discoverPluginChannels())[0]?.label).toBe("iMessage");
  });

  test("skips a disabled plugin", async () => {
    // Same source of truth the loader uses for hooks, tools and routes: a
    // disabled plugin would otherwise offer a setup flow that cannot run.
    const dir = writePlugin("imessage", { ingress: INGRESS });
    writeFileSync(join(dir, ".disabled"), "");

    expect(await discoverPluginChannels()).toEqual([]);
  });

  test("titles a plugin that names no display name", async () => {
    // Presentation is best-effort, so a bare manifest costs a nicer title and
    // never the row itself.
    writePlugin("meeting-bot", { ingress: INGRESS });

    expect(await discoverPluginChannels()).toEqual([
      {
        id: "plugin:meeting-bot",
        plugin: "meeting-bot",
        label: "Meeting Bot",
        description: undefined,
        icon: undefined,
      },
    ]);
  });

  test("still lists a channel whose manifest cannot be read", async () => {
    // The directory is the plugin's identity, so an unparseable manifest
    // costs its presentation and not its existence.
    const dir = writePlugin("imessage", { ingress: INGRESS });
    writeFileSync(join(dir, "package.json"), "{ not json");

    expect((await discoverPluginChannels())[0]?.label).toBe("Imessage");
  });
});
