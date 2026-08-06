/**
 * Guards over the `pluginUpdates` config block — the opt-in that decides
 * whether installed plugins move on their own.
 *
 * The defaults are the contract: a workspace that says nothing must behave
 * exactly as it did before the block existed (manual, nothing upgrades), and
 * an opted-in workspace must land on the `theirs` merge strategy.
 */

import { describe, expect, test } from "bun:test";

import { PluginUpdatesConfigSchema } from "../schemas/plugin-updates.js";

describe("pluginUpdates config schema", () => {
  test("defaults are manual / theirs / hourly", () => {
    expect(PluginUpdatesConfigSchema.parse({})).toEqual({
      mode: "manual",
      strategy: "theirs",
      checkIntervalMs: 3_600_000,
    });
  });

  test("mode accepts only manual and auto", () => {
    expect(PluginUpdatesConfigSchema.parse({ mode: "auto" }).mode).toBe("auto");
    expect(
      PluginUpdatesConfigSchema.safeParse({ mode: "sometimes" }).success,
    ).toBe(false);
  });

  test("the unattended-hostile `assistant` strategy is not selectable", () => {
    // It resolves conflicts by writing git conflict markers into the plugin's
    // files, which unattended would leave broken code on disk.
    expect(
      PluginUpdatesConfigSchema.safeParse({ strategy: "assistant" }).success,
    ).toBe(false);
  });

  test("sub-5-minute sweep intervals are rejected", () => {
    expect(
      PluginUpdatesConfigSchema.safeParse({ checkIntervalMs: 1_000 }).success,
    ).toBe(false);
  });
});
