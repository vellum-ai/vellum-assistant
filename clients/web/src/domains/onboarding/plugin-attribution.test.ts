import { describe, expect, it } from "bun:test";

import {
  ATTRIBUTED_PLUGIN_PARAM,
  pluginsFromAttribution,
} from "@/domains/onboarding/plugin-attribution";

describe("pluginsFromAttribution", () => {
  it("returns the attributed plugin from the query string", () => {
    expect(pluginsFromAttribution("?plugin=coffee-aficionado")).toEqual([
      "coffee-aficionado",
    ]);
  });

  it("reads it alongside other onboarding params (order-independent)", () => {
    expect(
      pluginsFromAttribution("?hosting=managed&plugin=coffee-aficionado"),
    ).toEqual(["coffee-aficionado"]);
  });

  it("is empty when the param is absent", () => {
    expect(pluginsFromAttribution("")).toEqual([]);
    expect(pluginsFromAttribution("?hosting=managed")).toEqual([]);
  });

  it("is empty for a present-but-blank param", () => {
    expect(pluginsFromAttribution("?plugin=")).toEqual([]);
    expect(pluginsFromAttribution("?plugin=%20%20")).toEqual([]);
  });

  it("decodes a percent-encoded value", () => {
    expect(pluginsFromAttribution("?plugin=git%2Dworkflow")).toEqual([
      "git-workflow",
    ]);
  });

  it("uses the constant the marketing side must match", () => {
    expect(ATTRIBUTED_PLUGIN_PARAM).toBe("plugin");
    expect(
      pluginsFromAttribution(`?${ATTRIBUTED_PLUGIN_PARAM}=git-workflow`),
    ).toEqual(["git-workflow"]);
  });
});
