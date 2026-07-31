import { describe, expect, test } from "bun:test";

import {
  capabilityOrDiskBody,
  type CapabilityResolvers,
  isCapabilitySlug,
  renderCapabilityBody,
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

const resolvers: CapabilityResolvers = {
  skill: (slug) =>
    slug === "skills/foo" ? { id: "foo", content: "foo capability" } : null,
  cli: (slug) =>
    slug === "cli-commands/bar"
      ? {
          id: "bar",
          description: "manages bars",
          content:
            'The "assistant bar" CLI command is available. manages bars.\n\nFull help:\n  --baz  a very long flag description',
        }
      : null,
};

describe("renderCapabilityContent (injection form)", () => {
  test("renders a skill slug with a Skill header and its content", () => {
    expect(renderCapabilityContent("skills/foo", resolvers)).toBe(
      "# Skill: foo\nfoo capability",
    );
  });

  test("renders a CLI-command slug as its one-line summary, never the full help", () => {
    const rendered = renderCapabilityContent("cli-commands/bar", resolvers);
    expect(rendered).toBe(
      '# CLI command: bar\nThe "assistant bar" CLI command is available. manages bars. Run `assistant bar --help` for full usage.',
    );
    expect(rendered).not.toContain("Full help:");
  });

  test("degrades to '' for a capability slug the cache cannot resolve", () => {
    expect(renderCapabilityContent("skills/missing", resolvers)).toBe("");
  });

  test("returns null for a non-capability slug so the caller reads the on-disk page", () => {
    expect(renderCapabilityContent("relationship/vows", resolvers)).toBeNull();
  });
});

describe("renderCapabilityBody (index form)", () => {
  test("renders a CLI-command slug with its full content for the section index", () => {
    expect(renderCapabilityBody("cli-commands/bar", resolvers)).toBe(
      '# CLI command: bar\nThe "assistant bar" CLI command is available. manages bars.\n\nFull help:\n  --baz  a very long flag description',
    );
  });

  test("renders a skill slug identically to the injection form", () => {
    expect(renderCapabilityBody("skills/foo", resolvers)).toBe(
      renderCapabilityContent("skills/foo", resolvers),
    );
  });

  test("degrades to '' / null on the same contract as the injection form", () => {
    expect(renderCapabilityBody("cli-commands/missing", resolvers)).toBe("");
    expect(renderCapabilityBody("relationship/vows", resolvers)).toBeNull();
  });
});

describe("capabilityOrDiskBody", () => {
  test("a capability slug routes through renderCapabilityBody and never reads disk", async () => {
    let diskReads = 0;
    const readDiskBody = async (): Promise<string> => {
      diskReads += 1;
      return "disk body — should not be read";
    };
    // A capability slug whose production cache has no entry degrades to "" (the
    // `renderCapabilityBody` contract) rather than falling through to the
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
