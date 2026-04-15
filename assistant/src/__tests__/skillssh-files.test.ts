import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import {
  clearDirPathCache,
  createSkillsShProvider,
} from "../skills/skillssh-files.js";

// ─── Fetch mock helpers ──────────────────────────────────────────────────────

const originalFetch = globalThis.fetch;

let mockFetchImpl: (url: string | URL | Request) => Promise<Response>;

beforeEach(() => {
  clearDirPathCache();
  mockFetchImpl = () =>
    Promise.resolve(new Response("not mocked", { status: 500 }));
  globalThis.fetch = mock((input: string | URL | Request) =>
    mockFetchImpl(typeof input === "string" ? input : input.toString()),
  ) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ─── canHandle ──────────────────────────────────────────────────────────────

describe("canHandle", () => {
  const provider = createSkillsShProvider();

  test("returns true for owner/repo/skill format", () => {
    expect(provider.canHandle("owner/repo/skill")).toBe(true);
  });

  test("returns true for deeply nested slug", () => {
    expect(provider.canHandle("owner/repo/skill/extra")).toBe(true);
  });

  test("returns false for simple slug", () => {
    expect(provider.canHandle("simple-slug")).toBe(false);
  });

  test("returns false for owner/repo format (only 2 segments)", () => {
    expect(provider.canHandle("owner/repo")).toBe(false);
  });
});

// ─── listFiles ──────────────────────────────────────────────────────────────

describe("listFiles", () => {
  test("returns entries via conventional path", async () => {
    const provider = createSkillsShProvider();

    mockFetchImpl = (url: string | URL | Request) => {
      const urlStr = url.toString();

      // Probe for conventional path — returns directory listing
      if (urlStr.includes("/contents/skills/my-skill")) {
        return Promise.resolve(
          new Response(
            JSON.stringify([
              {
                name: "SKILL.md",
                type: "file",
                download_url: "https://raw.example.com/SKILL.md",
              },
              {
                name: "tools.ts",
                type: "file",
                download_url: "https://raw.example.com/tools.ts",
              },
            ]),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        );
      }

      return Promise.resolve(new Response("not found", { status: 404 }));
    };

    const entries = await provider.listFiles("owner/repo/my-skill");
    expect(entries).not.toBeNull();
    expect(entries!.length).toBe(2);
    expect(entries![0]!.path).toBe("SKILL.md");
    expect(entries![0]!.content).toBeNull();
    expect(entries![1]!.path).toBe("tools.ts");
    expect(entries![1]!.content).toBeNull();
  });

  test("returns entries via tree-search fallback", async () => {
    const provider = createSkillsShProvider();

    mockFetchImpl = (url: string | URL | Request) => {
      const urlStr = url.toString();

      // Conventional path returns 404
      if (
        urlStr.includes("/contents/skills/csv") &&
        !urlStr.includes("examples")
      ) {
        return Promise.resolve(new Response("Not Found", { status: 404 }));
      }

      // Tree search finds it at a non-standard path
      if (urlStr.includes("/git/trees/")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              tree: [
                { path: "examples/skills/csv/SKILL.md", type: "blob" },
                { path: "examples/skills/csv/filter.sh", type: "blob" },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        );
      }

      // Contents API for the discovered path
      if (urlStr.includes("/contents/examples/skills/csv")) {
        return Promise.resolve(
          new Response(
            JSON.stringify([
              {
                name: "SKILL.md",
                type: "file",
                download_url: "https://raw.example.com/SKILL.md",
              },
              {
                name: "filter.sh",
                type: "file",
                download_url: "https://raw.example.com/filter.sh",
              },
            ]),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        );
      }

      return Promise.resolve(new Response("not found", { status: 404 }));
    };

    const entries = await provider.listFiles("vercel-labs/bash-tool/csv");
    expect(entries).not.toBeNull();
    expect(entries!.length).toBe(2);
    expect(entries!.some((e) => e.path === "SKILL.md")).toBe(true);
    expect(entries!.some((e) => e.path === "filter.sh")).toBe(true);
  });

  test("returns null on GitHub API error", async () => {
    const provider = createSkillsShProvider();

    mockFetchImpl = () =>
      Promise.resolve(new Response("Internal Server Error", { status: 500 }));

    const entries = await provider.listFiles("owner/repo/my-skill");
    expect(entries).toBeNull();
  });

  test("returns null for malformed skill id", async () => {
    const provider = createSkillsShProvider();
    const entries = await provider.listFiles("simple-slug");
    expect(entries).toBeNull();
  });

  test("skips hidden files and SKIP_DIRS", async () => {
    const provider = createSkillsShProvider();

    mockFetchImpl = (url: string | URL | Request) => {
      const urlStr = url.toString();

      if (urlStr.includes("/contents/skills/my-skill")) {
        return Promise.resolve(
          new Response(
            JSON.stringify([
              {
                name: "SKILL.md",
                type: "file",
                download_url: "https://raw.example.com/SKILL.md",
              },
              {
                name: ".env",
                type: "file",
                download_url: "https://raw.example.com/.env",
              },
              {
                name: "node_modules",
                type: "dir",
                download_url: null,
              },
              {
                name: ".git",
                type: "dir",
                download_url: null,
              },
            ]),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        );
      }

      return Promise.resolve(new Response("not found", { status: 404 }));
    };

    const entries = await provider.listFiles("owner/repo/my-skill");
    expect(entries).not.toBeNull();
    expect(entries!.length).toBe(1);
    expect(entries![0]!.path).toBe("SKILL.md");
  });
});

// ─── readFileContent ────────────────────────────────────────────────────────

describe("readFileContent", () => {
  test("returns text content inline", async () => {
    const provider = createSkillsShProvider();

    mockFetchImpl = (url: string | URL | Request) => {
      const urlStr = url.toString();

      // Probe for conventional path — returns 200 for dir probe
      if (
        urlStr.includes("/contents/skills/my-skill") &&
        !urlStr.includes("SKILL.md")
      ) {
        return Promise.resolve(
          new Response(
            JSON.stringify([
              {
                name: "SKILL.md",
                type: "file",
                download_url: "https://raw.example.com/SKILL.md",
              },
            ]),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        );
      }

      // Individual file fetch via Contents API
      if (urlStr.includes("/contents/skills/my-skill/SKILL.md")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              name: "SKILL.md",
              type: "file",
              size: 42,
              download_url: "https://raw.example.com/SKILL.md",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        );
      }

      // File content download
      if (urlStr.includes("raw.example.com/SKILL.md")) {
        return Promise.resolve(
          new Response("# My Skill\nDescription here", { status: 200 }),
        );
      }

      return Promise.resolve(new Response("not found", { status: 404 }));
    };

    const entry = await provider.readFileContent(
      "owner/repo/my-skill",
      "SKILL.md",
    );
    expect(entry).not.toBeNull();
    expect(entry!.path).toBe("SKILL.md");
    expect(entry!.name).toBe("SKILL.md");
    expect(entry!.isBinary).toBe(false);
    expect(entry!.content).toBe("# My Skill\nDescription here");
  });

  test("returns null for binary files", async () => {
    const provider = createSkillsShProvider();

    mockFetchImpl = (url: string | URL | Request) => {
      const urlStr = url.toString();

      // Probe for conventional path
      if (
        urlStr.includes("/contents/skills/my-skill") &&
        !urlStr.includes("logo.png")
      ) {
        return Promise.resolve(
          new Response(JSON.stringify([]), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );
      }

      // Individual file fetch
      if (urlStr.includes("/contents/skills/my-skill/logo.png")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              name: "logo.png",
              type: "file",
              size: 1024,
              download_url: "https://raw.example.com/logo.png",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        );
      }

      return Promise.resolve(new Response("not found", { status: 404 }));
    };

    const entry = await provider.readFileContent(
      "owner/repo/my-skill",
      "logo.png",
    );
    expect(entry).not.toBeNull();
    expect(entry!.isBinary).toBe(true);
    expect(entry!.content).toBeNull();
  });

  test("returns null when file does not exist", async () => {
    const provider = createSkillsShProvider();

    mockFetchImpl = (url: string | URL | Request) => {
      const urlStr = url.toString();

      // Probe for conventional path
      if (
        urlStr.includes("/contents/skills/my-skill") &&
        !urlStr.includes("nonexistent.md")
      ) {
        return Promise.resolve(
          new Response(JSON.stringify([]), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );
      }

      // File not found
      if (urlStr.includes("/contents/skills/my-skill/nonexistent.md")) {
        return Promise.resolve(new Response("Not Found", { status: 404 }));
      }

      return Promise.resolve(new Response("not found", { status: 404 }));
    };

    const entry = await provider.readFileContent(
      "owner/repo/my-skill",
      "nonexistent.md",
    );
    expect(entry).toBeNull();
  });

  test("returns null for hidden/skipped paths", async () => {
    const provider = createSkillsShProvider();

    const entry1 = await provider.readFileContent(
      "owner/repo/my-skill",
      ".env",
    );
    expect(entry1).toBeNull();

    const entry2 = await provider.readFileContent(
      "owner/repo/my-skill",
      "node_modules/pkg/index.js",
    );
    expect(entry2).toBeNull();
  });
});

// ─── toSlimSkill ────────────────────────────────────────────────────────────

describe("toSlimSkill", () => {
  const provider = createSkillsShProvider();

  test("returns valid SkillsshSlimSkill for well-formed slug", async () => {
    const slim = await provider.toSlimSkill("owner/repo/my-skill");
    expect(slim).not.toBeNull();
    expect(slim!.id).toBe("owner/repo/my-skill");
    expect(slim!.name).toBe("my-skill");
    expect(slim!.kind).toBe("catalog");
    expect(slim!.status).toBe("available");
    expect(slim!.origin).toBe("skillssh");
    expect((slim as any).slug).toBe("owner/repo/my-skill");
    expect((slim as any).sourceRepo).toBe("owner/repo");
    expect((slim as any).installs).toBe(0);
  });

  test("returns null for malformed slug", async () => {
    const slim = await provider.toSlimSkill("bad-slug");
    expect(slim).toBeNull();
  });
});

// ─── Cache behavior ─────────────────────────────────────────────────────────

describe("cache", () => {
  test("cache hit avoids re-probing GitHub", async () => {
    const provider = createSkillsShProvider();
    const fetchedUrls: string[] = [];

    mockFetchImpl = (url: string | URL | Request) => {
      const urlStr = url.toString();
      fetchedUrls.push(urlStr);

      // Both the dir probe and the listing hit the same Contents API URL.
      // Return a valid directory listing for both.
      if (urlStr.includes("/contents/skills/my-skill")) {
        return Promise.resolve(
          new Response(
            JSON.stringify([
              {
                name: "SKILL.md",
                type: "file",
                download_url: "https://raw.example.com/SKILL.md",
              },
            ]),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        );
      }

      return Promise.resolve(new Response("not found", { status: 404 }));
    };

    // First call: resolveSkillDir probes + listGitHubDir lists = 2 fetches
    const entries1 = await provider.listFiles("owner/repo/my-skill");
    expect(entries1).not.toBeNull();
    const contentsCallsAfterFirst = fetchedUrls.filter((u) =>
      u.includes("/contents/skills/my-skill"),
    ).length;
    expect(contentsCallsAfterFirst).toBe(2); // 1 probe + 1 listing

    // Second call: resolveSkillDir uses cache + listGitHubDir lists = 1 fetch
    const entries2 = await provider.listFiles("owner/repo/my-skill");
    expect(entries2).not.toBeNull();
    const contentsCallsAfterSecond = fetchedUrls.filter((u) =>
      u.includes("/contents/skills/my-skill"),
    ).length;
    // Only 1 additional call (the listing), not 2. The probe is cached.
    expect(contentsCallsAfterSecond).toBe(3); // 2 from first + 1 listing from second
  });
});
