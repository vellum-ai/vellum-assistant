import { afterEach, describe, expect, test } from "bun:test";

import { noConnectionsMessage } from "./status.js";

const original = process.env.__RESOLVED_MODEL;

afterEach(() => {
  if (original === undefined) delete process.env.__RESOLVED_MODEL;
  else process.env.__RESOLVED_MODEL = original;
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
    expect(msg).not.toContain("assistant oauth connect google");
  });
});
