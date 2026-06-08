import { describe, expect, test } from "bun:test";

import {
  type CapabilityResolvers,
  isCapabilitySlug,
  renderCapabilityContent,
} from "../capabilities.js";

describe("isCapabilitySlug", () => {
  test("true for skill and CLI-command slugs, false otherwise", () => {
    expect(isCapabilitySlug("skills/meet-join")).toBe(true);
    expect(isCapabilitySlug("cli-commands/schedules")).toBe(true);
    expect(isCapabilitySlug("relationship/vows")).toBe(false);
    expect(isCapabilitySlug("some-page")).toBe(false);
  });
});

describe("renderCapabilityContent", () => {
  const resolvers: CapabilityResolvers = {
    skill: (slug) =>
      slug === "skills/foo" ? { id: "foo", content: "foo capability" } : null,
    cli: (slug) =>
      slug === "cli-commands/bar"
        ? { id: "bar", content: "bar capability" }
        : null,
  };

  test("renders a skill slug with a Skill header", () => {
    expect(renderCapabilityContent("skills/foo", resolvers)).toBe(
      "# Skill: foo\nfoo capability",
    );
  });

  test("renders a CLI-command slug with a CLI header", () => {
    expect(renderCapabilityContent("cli-commands/bar", resolvers)).toBe(
      "# CLI command: bar\nbar capability",
    );
  });

  test("degrades to '' for a capability slug the cache cannot resolve", () => {
    expect(renderCapabilityContent("skills/missing", resolvers)).toBe("");
  });

  test("returns null for a non-capability slug so the caller reads the on-disk page", () => {
    expect(renderCapabilityContent("relationship/vows", resolvers)).toBeNull();
  });
});
