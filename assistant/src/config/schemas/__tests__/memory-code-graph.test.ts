import { describe, expect, it } from "bun:test";

import { CodeGraphConfigSchema } from "../memory-code-graph.js";

describe("CodeGraphConfigSchema", () => {
  it("parses an empty object with defaults", () => {
    const config = CodeGraphConfigSchema.parse({});
    expect(config.enabled).toBe(true);
    expect(config.repoPaths).toEqual([]);
    expect(config.autoWatch).toBe(true);
  });

  it("accepts repoPaths as plain strings", () => {
    const config = CodeGraphConfigSchema.parse({
      repoPaths: ["/tmp/repo1", "/tmp/repo2"],
    });
    expect(config.repoPaths).toHaveLength(2);
    expect(config.repoPaths[0]).toBe("/tmp/repo1");
  });

  it("accepts repoPaths as objects with includeDirs", () => {
    const config = CodeGraphConfigSchema.parse({
      repoPaths: [
        {
          path: "/tmp/platform-repo",
          includeDirs: ["web/src", "vembda/src"],
        },
      ],
    });
    expect(config.repoPaths).toHaveLength(1);
    expect(config.repoPaths[0]).toEqual({
      path: "/tmp/platform-repo",
      includeDirs: ["web/src", "vembda/src"],
    });
  });

  it("rejects an unknown shape for repoPaths entries", () => {
    expect(() =>
      CodeGraphConfigSchema.parse({
        repoPaths: [42],
      }),
    ).toThrow();
  });

  it("round-trips explicit enabled false", () => {
    const config = CodeGraphConfigSchema.parse({ enabled: false });
    expect(config.enabled).toBe(false);
  });

  it("round-trips autoWatch false", () => {
    const config = CodeGraphConfigSchema.parse({ autoWatch: false });
    expect(config.autoWatch).toBe(false);
  });
});
