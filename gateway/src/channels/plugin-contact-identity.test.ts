import { describe, expect, test } from "bun:test";

import {
  expandPluginChannelTwins,
  isPluginDiscoveredChannelType,
  pluginInboundAddress,
} from "./plugin-contact-identity.js";

describe("isPluginDiscoveredChannelType", () => {
  test("treats a plugin directory name as discovered", () => {
    expect(isPluginDiscoveredChannelType("imessage")).toBe(true);
    expect(isPluginDiscoveredChannelType("meeting-bot")).toBe(true);
  });

  test("rejects built-in channel ids, including plugin itself", () => {
    expect(isPluginDiscoveredChannelType("plugin")).toBe(false);
    expect(isPluginDiscoveredChannelType("phone")).toBe(false);
    expect(isPluginDiscoveredChannelType("slack")).toBe(false);
    expect(isPluginDiscoveredChannelType("")).toBe(false);
  });
});

describe("pluginInboundAddress", () => {
  test("scopes an E.164 number to the plugin", () => {
    expect(pluginInboundAddress("imessage", "+12025550142")).toBe(
      "imessage:+12025550142",
    );
  });

  test("canonicalizes a US national number before scoping", () => {
    expect(pluginInboundAddress("imessage", "2025550142")).toBe(
      "imessage:+12025550142",
    );
  });

  test("scopes a handle that is not a phone number as-is", () => {
    expect(pluginInboundAddress("meeting-bot", "room-42")).toBe(
      "meeting-bot:room-42",
    );
  });

  test("returns null for an empty address", () => {
    expect(pluginInboundAddress("imessage", "   ")).toBeNull();
    expect(pluginInboundAddress("imessage", "")).toBeNull();
  });
});

describe("expandPluginChannelTwins", () => {
  test("adds a plugin twin and drops the discovered row's id", () => {
    const expanded = expandPluginChannelTwins([
      {
        id: "ch-imessage",
        type: "imessage",
        address: "+12025550142",
        status: "unverified",
      },
    ]);

    expect(expanded).toHaveLength(2);
    expect(expanded[0]).toEqual({
      id: "ch-imessage",
      type: "imessage",
      address: "+12025550142",
      status: "unverified",
    });
    expect(expanded[1]?.type).toBe("plugin");
    expect(expanded[1]?.address).toBe("imessage:+12025550142");
    expect(expanded[1]?.status).toBe("unverified");
    expect(expanded[1]).not.toHaveProperty("id");
  });

  test("leaves built-in channels unchanged", () => {
    const channels = [{ type: "phone", address: "+12025550142" }];
    expect(expandPluginChannelTwins(channels)).toEqual(channels);
  });

  test("skips a discovered channel with no address", () => {
    const channels = [{ type: "imessage", address: "" }];
    expect(expandPluginChannelTwins(channels)).toEqual(channels);
  });
});
