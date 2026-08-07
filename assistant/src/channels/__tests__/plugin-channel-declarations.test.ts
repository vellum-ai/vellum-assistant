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
    writePlugin("courier", {
      ingress: INGRESS,
      manifest: {
        displayName: "Courier",
        description: "Reach the assistant by carrier pigeon.",
        icon: "send",
      },
    });

    expect(await discoverPluginChannels()).toEqual([
      {
        id: "courier",
        source: "plugin:courier",
        label: "Courier",
        subtitle: "Reach the assistant by carrier pigeon.",
        icon: "send",
        supportsVerification: false,
        setupMessages: {
          guardian: "I want to set up Courier. Can you help me?",
          contact:
            "I'd like to reach you on Courier. Can you help me get set up?",
        },
      },
    ]);
  });

  test("ignores a plugin that declares no ingress", async () => {
    // Presentation alone does not make a channel: reaching the assistant from
    // outside is what one is, and ingress is where that is declared.
    writePlugin("notes", { manifest: { displayName: "Notes", icon: "send" } });

    expect(await discoverPluginChannels()).toEqual([]);
  });

  test("surfaces a channel whose ingress the gateway would reject", async () => {
    // Validation belongs to the gateway, which owns the schema. A plugin with
    // a broken declaration is a channel with broken ingress, and saying so
    // beats dropping it off the page a guardian would look at.
    writePlugin("courier", {
      ingress: "{ not json",
      manifest: { displayName: "Courier" },
    });

    expect((await discoverPluginChannels())[0]?.label).toBe("Courier");
  });

  test("skips a disabled plugin", async () => {
    // Same source of truth the loader uses for hooks, tools and routes: a
    // disabled plugin would otherwise offer a setup flow that cannot run.
    const dir = writePlugin("courier", { ingress: INGRESS });
    writeFileSync(join(dir, ".disabled"), "");

    expect(await discoverPluginChannels()).toEqual([]);
  });

  test("refuses to let a plugin take a built-in channel's id", async () => {
    // Two rows sharing an id would be ambiguous to any client keying on one,
    // and letting the plugin win would let it impersonate a built-in.
    writePlugin("slack", {
      ingress: INGRESS,
      manifest: { displayName: "Slack" },
    });

    expect(await discoverPluginChannels()).toEqual([]);
  });

  test("titles a plugin that names no display name", async () => {
    // Presentation is best-effort, so a bare manifest costs a nicer title and
    // never the row itself.
    writePlugin("meeting-bot", { ingress: INGRESS });

    expect(await discoverPluginChannels()).toMatchObject([
      {
        id: "meeting-bot",
        source: "plugin:meeting-bot",
        label: "Meeting Bot",
        subtitle: "Provided by the Meeting Bot plugin",
        icon: "message-square",
      },
    ]);
  });

  test("still lists a channel whose manifest cannot be read", async () => {
    // The directory is the plugin's identity, so an unparseable manifest
    // costs its presentation and not its existence.
    const dir = writePlugin("courier", { ingress: INGRESS });
    writeFileSync(join(dir, "package.json"), "{ not json");

    expect((await discoverPluginChannels())[0]?.label).toBe("Courier");
  });

  test("never claims a plugin channel supports verification", async () => {
    // There is no client-side verification flow for one, so clients render it
    // display-only rather than pre-warming a status that cannot arrive.
    writePlugin("courier", { ingress: INGRESS });

    expect((await discoverPluginChannels())[0]?.supportsVerification).toBe(
      false,
    );
  });
});
