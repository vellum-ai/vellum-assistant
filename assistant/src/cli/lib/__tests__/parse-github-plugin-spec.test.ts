import { describe, expect, test } from "bun:test";

import {
  DEFAULT_DIRECT_REF,
  InvalidGitHubPluginSpecError,
  looksLikeGitHubSpec,
  parseGitHubPluginSpec,
} from "../parse-github-plugin-spec.js";

describe("looksLikeGitHubSpec", () => {
  test.each([
    "https://github.com/owner/repo",
    "github.com/owner/repo",
    "owner/repo",
    "owner/repo/sub/path",
    "http://github.com/owner/repo",
  ])("treats %p as a GitHub locator", (spec) => {
    expect(looksLikeGitHubSpec(spec)).toBe(true);
  });

  test.each(["example", "simple-memory", "plugin_2", "a"])(
    "treats marketplace name %p as not a GitHub locator",
    (name) => {
      expect(looksLikeGitHubSpec(name)).toBe(false);
    },
  );
});

describe("parseGitHubPluginSpec", () => {
  test("parses a bare repo URL with default ref and root path", () => {
    const spec = parseGitHubPluginSpec("https://github.com/owner/my-plugin");
    expect(spec).toEqual({
      owner: "owner",
      repo: "my-plugin",
      path: "",
      ref: DEFAULT_DIRECT_REF,
      defaultName: "my-plugin",
    });
  });

  test("strips a trailing .git and a trailing slash", () => {
    const spec = parseGitHubPluginSpec(
      "https://github.com/owner/my-plugin.git/",
    );
    expect(spec.repo).toBe("my-plugin");
    expect(spec.path).toBe("");
  });

  test("parses the canonical /tree/<ref>/<path> form", () => {
    const spec = parseGitHubPluginSpec(
      "https://github.com/owner/repo/tree/my-branch/packages/cool-plugin",
    );
    expect(spec).toEqual({
      owner: "owner",
      repo: "repo",
      path: "packages/cool-plugin",
      ref: "my-branch",
      defaultName: "cool-plugin",
    });
  });

  test("a /tree/<ref> with no sub-path keeps the root and uses the repo name", () => {
    const spec = parseGitHubPluginSpec(
      "https://github.com/owner/repo/tree/v1.2.3",
    );
    expect(spec.path).toBe("");
    expect(spec.ref).toBe("v1.2.3");
    expect(spec.defaultName).toBe("repo");
  });

  test("treats a non-tree trailing segment as the sub-path", () => {
    const spec = parseGitHubPluginSpec("github.com/owner/repo/sub/leaf");
    expect(spec.path).toBe("sub/leaf");
    expect(spec.ref).toBe(DEFAULT_DIRECT_REF);
    expect(spec.defaultName).toBe("leaf");
  });

  test("accepts the scheme-less owner/repo shorthand", () => {
    const spec = parseGitHubPluginSpec("owner/repo");
    expect(spec.owner).toBe("owner");
    expect(spec.repo).toBe("repo");
  });

  test("lower-cases the derived default name", () => {
    const spec = parseGitHubPluginSpec("https://github.com/Owner/Caveman");
    expect(spec.defaultName).toBe("caveman");
  });

  test("drops a query string and fragment", () => {
    const spec = parseGitHubPluginSpec(
      "https://github.com/owner/repo/tree/main/pkg?tab=readme#install",
    );
    expect(spec.path).toBe("pkg");
    expect(spec.ref).toBe("main");
  });

  test.each([
    ["https://gitlab.com/owner/repo", "only github.com"],
    ["https://example.com/owner/repo", "only github.com"],
  ])("rejects non-github hosts %p", (spec, needle) => {
    expect(() => parseGitHubPluginSpec(spec)).toThrow(
      InvalidGitHubPluginSpecError,
    );
    expect(() => parseGitHubPluginSpec(spec)).toThrow(needle);
  });

  test.each(["owner", "github.com/owner", "https://github.com/owner", ""])(
    "rejects a locator missing the repo %p",
    (spec) => {
      expect(() => parseGitHubPluginSpec(spec)).toThrow(
        InvalidGitHubPluginSpecError,
      );
    },
  );

  test("rejects a sub-path that escapes the repo with ..", () => {
    expect(() =>
      parseGitHubPluginSpec("github.com/owner/repo/tree/main/../etc"),
    ).toThrow(InvalidGitHubPluginSpecError);
  });
});
