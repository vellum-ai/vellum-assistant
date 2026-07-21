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
    expect(spec.owner).toBe("owner");
    expect(spec.repo).toBe("repo");
    // The shortest-ref split is the default; the caller confirms the real split
    // against the remote via `refCandidates`.
    expect(spec.path).toBe("packages/cool-plugin");
    expect(spec.ref).toBe("my-branch");
    expect(spec.defaultName).toBe("cool-plugin");
  });

  test("enumerates every ref/path split, longest-ref-first, for an ambiguous /tree form", () => {
    const spec = parseGitHubPluginSpec(
      "https://github.com/owner/repo/tree/feat/results-viewer",
    );
    // `feat/results-viewer` could be branch `feat` + path `results-viewer`, or
    // branch `feat/results-viewer` at the repo root. Both are offered, longer
    // ref first, each carrying the install name derived from its sub-path.
    expect(spec.refCandidates).toEqual([
      { ref: "feat/results-viewer", path: "", defaultName: "repo" },
      { ref: "feat", path: "results-viewer", defaultName: "results-viewer" },
    ]);
    // The default (shortest ref) mirrors the pre-resolution behavior.
    expect(spec.ref).toBe("feat");
    expect(spec.path).toBe("results-viewer");
  });

  test("carries candidates when a slashed branch precedes a real sub-path", () => {
    const spec = parseGitHubPluginSpec(
      "github.com/owner/repo/tree/feat/results-viewer/integrations/vellum",
    );
    expect(spec.refCandidates).toEqual([
      {
        ref: "feat/results-viewer/integrations/vellum",
        path: "",
        defaultName: "repo",
      },
      {
        ref: "feat/results-viewer/integrations",
        path: "vellum",
        defaultName: "vellum",
      },
      {
        ref: "feat/results-viewer",
        path: "integrations/vellum",
        defaultName: "vellum",
      },
      {
        ref: "feat",
        path: "results-viewer/integrations/vellum",
        defaultName: "vellum",
      },
    ]);
  });

  test("a /tree/<ref> with no sub-path keeps the root and uses the repo name", () => {
    const spec = parseGitHubPluginSpec(
      "https://github.com/owner/repo/tree/v1.2.3",
    );
    expect(spec.path).toBe("");
    expect(spec.ref).toBe("v1.2.3");
    expect(spec.defaultName).toBe("repo");
    // A single post-`tree` segment is unambiguous — no candidate list.
    expect(spec.refCandidates).toBeUndefined();
  });

  test("a non-tree sub-path carries no ref candidates", () => {
    const spec = parseGitHubPluginSpec("github.com/owner/repo/sub/leaf");
    expect(spec.refCandidates).toBeUndefined();
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
