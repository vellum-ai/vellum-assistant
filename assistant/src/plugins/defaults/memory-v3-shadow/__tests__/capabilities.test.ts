import { describe, expect, test } from "bun:test";

import {
  capabilityOrDiskBody,
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

describe("capabilityOrDiskBody", () => {
  test("a capability slug routes through renderCapabilityContent and never reads disk", async () => {
    let diskReads = 0;
    const readDiskBody = async (): Promise<string> => {
      diskReads += 1;
      return "disk body — should not be read";
    };
    // A capability slug whose production cache has no entry degrades to "" (the
    // `renderCapabilityContent` contract) rather than falling through to the
    // injected disk reader, which must stay untouched.
    expect(await capabilityOrDiskBody("skills/example", readDiskBody)).toBe("");
    expect(diskReads).toBe(0);
  });

  test("a non-capability slug returns the injected disk reader's result", async () => {
    const readDiskBody = async (slug: string): Promise<string> =>
      `disk body for ${slug}`;
    expect(await capabilityOrDiskBody("relationship/vows", readDiskBody)).toBe(
      "disk body for relationship/vows",
    );
  });
});
