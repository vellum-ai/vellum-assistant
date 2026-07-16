import { afterEach, describe, expect, test } from "bun:test";

import { oauthHelp } from "./index.help.js";
import { decorateStatusJsonForModel, noConnectionsMessage } from "./status.js";

const original = process.env.__RESOLVED_MODEL;

afterEach(() => {
  if (original === undefined) {
    delete process.env.__RESOLVED_MODEL;
  } else {
    process.env.__RESOLVED_MODEL = original;
  }
});

describe("noConnectionsMessage", () => {
  test("capable models get the terse default", async () => {
    process.env.__RESOLVED_MODEL = "claude-opus-4-8";
    const msg = await noConnectionsMessage("google");
    expect(msg).toBe(
      "No active connections for google.\n" +
        "Connect with `assistant oauth connect google`.\n",
    );
  });

  test("no resolved model falls back to the terse default", async () => {
    delete process.env.__RESOLVED_MODEL;
    expect(await noConnectionsMessage("google")).toContain(
      "Connect with `assistant oauth connect google`.",
    );
  });

  test("weak open models are steered to the oauth_connect surface", async () => {
    process.env.__RESOLVED_MODEL = "accounts/fireworks/models/minimax-m3";
    const msg = await noConnectionsMessage("google");
    expect(msg).toContain('surface_type "oauth_connect"');
    expect(msg).toContain('data.providerKey "google"');
    expect(msg).toContain("paste an OAuth URL");
    expect(msg).not.toContain("assistant oauth connect google");
  });

  test("weak open model JSON status includes oauth_connect next action", async () => {
    process.env.__RESOLVED_MODEL = "accounts/fireworks/models/glm-5p2";
    const result = await decorateStatusJsonForModel({
      ok: true,
      provider: "google",
      mode: "managed",
      connections: [],
    });
    expect(result.hint).toContain('surface_type "oauth_connect"');
    expect(result.hint).toContain("paste an OAuth URL");
    expect(result.nextAction).toEqual({
      type: "ui_show",
      surfaceType: "oauth_connect",
      data: { providerKey: "google" },
    });
  });

  test("capable model JSON status stays compact", async () => {
    process.env.__RESOLVED_MODEL = "claude-opus-4-8";
    const result = await decorateStatusJsonForModel({
      ok: true,
      provider: "google",
      mode: "managed",
      connections: [],
    });
    expect(result.hint).toBeUndefined();
    expect(result.nextAction).toBeUndefined();
  });
});

describe("oauth connect help", () => {
  test("steers chat turns to the oauth_connect surface", () => {
    const connectHelp = oauthHelp.subcommands?.find(
      (command) => command.name === "connect",
    );
    expect(connectHelp?.description).toContain("terminal/headless");
    expect(connectHelp?.helpText).toContain('surface_type "oauth_connect"');
    expect(connectHelp?.helpText).toContain(
      "avoids pasting raw authorization links",
    );
  });
});
