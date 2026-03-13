import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type {
  AuditResponse,
  SkillAuditData,
  SkillsShSearchResult,
} from "../skills/skillssh-registry.js";
import {
  fetchSkillAudits,
  fetchSkillFromGitHub,
  formatAuditBadges,
  providerDisplayName,
  resolveSkillSource,
  riskToDisplay,
  searchSkillsRegistry,
  validateSkillSlug,
} from "../skills/skillssh-registry.js";

// ─── Fetch mock helpers ──────────────────────────────────────────────────────

const originalFetch = globalThis.fetch;

let mockFetchImpl: (url: string | URL | Request) => Promise<Response>;

beforeEach(() => {
  mockFetchImpl = () =>
    Promise.resolve(new Response("not mocked", { status: 500 }));
  globalThis.fetch = mock((input: string | URL | Request) =>
    mockFetchImpl(typeof input === "string" ? input : input.toString()),
  ) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ─── searchSkillsRegistry ────────────────────────────────────────────────────

describe("searchSkillsRegistry", () => {
  test("sends correct query parameters and returns results", async () => {
    const mockResults: SkillsShSearchResult[] = [
      {
        id: "vercel-labs/agent-skills/vercel-react-best-practices",
        skillId: "vercel-react-best-practices",
        name: "Vercel React Best Practices",
        installs: 1200,
        source: "vercel-labs/agent-skills",
      },
    ];

    mockFetchImpl = (url: string | URL | Request) => {
      const urlStr = url.toString();
      expect(urlStr).toContain("skills.sh/api/search");
      expect(urlStr).toContain("q=react");
      expect(urlStr).toContain("limit=5");
      return Promise.resolve(
        new Response(JSON.stringify({ skills: mockResults }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    };

    const results = await searchSkillsRegistry("react", 5);
    expect(results).toEqual(mockResults);
  });

  test("omits limit parameter when not provided", async () => {
    mockFetchImpl = (url: string | URL | Request) => {
      const urlStr = url.toString();
      expect(urlStr).not.toContain("limit=");
      return Promise.resolve(
        new Response(JSON.stringify({ skills: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    };

    const results = await searchSkillsRegistry("test");
    expect(results).toEqual([]);
  });

  test("throws on non-OK response", async () => {
    mockFetchImpl = () =>
      Promise.resolve(new Response("Not Found", { status: 404 }));

    await expect(searchSkillsRegistry("bad-query")).rejects.toThrow(
      "skills.sh search failed: HTTP 404",
    );
  });
});

// ─── fetchSkillAudits ────────────────────────────────────────────────────────

describe("fetchSkillAudits", () => {
  test("sends correct parameters and returns audit data", async () => {
    const mockAudits: AuditResponse = {
      "vercel-react-best-practices": {
        ath: {
          risk: "safe",
          alerts: 0,
          score: 100,
          analyzedAt: "2025-01-15T00:00:00Z",
        },
        socket: {
          risk: "low",
          alerts: 1,
          score: 95,
          analyzedAt: "2025-01-15T00:00:00Z",
        },
      },
    };

    mockFetchImpl = (url: string | URL | Request) => {
      const urlStr = url.toString();
      expect(urlStr).toContain("add-skill.vercel.sh/audit");
      expect(urlStr).toContain("source=vercel-labs%2Fagent-skills");
      expect(urlStr).toContain(
        "skills=vercel-react-best-practices%2Canother-skill",
      );
      return Promise.resolve(
        new Response(JSON.stringify(mockAudits), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    };

    const audits = await fetchSkillAudits("vercel-labs/agent-skills", [
      "vercel-react-best-practices",
      "another-skill",
    ]);
    expect(audits).toEqual(mockAudits);
  });

  test("returns empty object for empty slugs list", async () => {
    const audits = await fetchSkillAudits("some/source", []);
    expect(audits).toEqual({});
    // fetch should not have been called
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  test("throws on non-OK response", async () => {
    mockFetchImpl = () =>
      Promise.resolve(new Response("Internal Server Error", { status: 500 }));

    await expect(fetchSkillAudits("some/source", ["slug"])).rejects.toThrow(
      "Audit fetch failed: HTTP 500",
    );
  });
});

// ─── Display helpers ─────────────────────────────────────────────────────────

describe("riskToDisplay", () => {
  test("maps risk levels correctly", () => {
    expect(riskToDisplay("safe")).toBe("PASS");
    expect(riskToDisplay("low")).toBe("PASS");
    expect(riskToDisplay("medium")).toBe("WARN");
    expect(riskToDisplay("high")).toBe("FAIL");
    expect(riskToDisplay("critical")).toBe("FAIL");
    expect(riskToDisplay("unknown")).toBe("?");
  });
});

describe("providerDisplayName", () => {
  test("maps known providers", () => {
    expect(providerDisplayName("ath")).toBe("ATH");
    expect(providerDisplayName("socket")).toBe("Socket");
    expect(providerDisplayName("snyk")).toBe("Snyk");
  });

  test("returns raw name for unknown providers", () => {
    expect(providerDisplayName("custom-auditor")).toBe("custom-auditor");
  });
});

describe("formatAuditBadges", () => {
  test("formats multiple providers as badges", () => {
    const auditData: SkillAuditData = {
      ath: { risk: "safe", analyzedAt: "2025-01-15T00:00:00Z" },
      socket: { risk: "safe", analyzedAt: "2025-01-15T00:00:00Z" },
      snyk: { risk: "medium", analyzedAt: "2025-01-15T00:00:00Z" },
    };
    expect(formatAuditBadges(auditData)).toBe(
      "Security: [ATH:PASS] [Socket:PASS] [Snyk:WARN]",
    );
  });

  test("returns fallback message when no providers present", () => {
    expect(formatAuditBadges({})).toBe("Security: no audit data");
  });

  test("handles single provider", () => {
    const auditData: SkillAuditData = {
      ath: { risk: "critical", analyzedAt: "2025-01-15T00:00:00Z" },
    };
    expect(formatAuditBadges(auditData)).toBe("Security: [ATH:FAIL]");
  });
});

// ─── resolveSkillSource ─────────────────────────────────────────────────────

describe("resolveSkillSource", () => {
  test("parses owner/repo@skill-name format", () => {
    const result = resolveSkillSource("vercel-labs/skills@find-skills");
    expect(result).toEqual({
      owner: "vercel-labs",
      repo: "skills",
      skillSlug: "find-skills",
    });
  });

  test("parses owner/repo/skill-name format", () => {
    const result = resolveSkillSource("vercel-labs/skills/find-skills");
    expect(result).toEqual({
      owner: "vercel-labs",
      repo: "skills",
      skillSlug: "find-skills",
    });
  });

  test("parses full GitHub URL with main branch", () => {
    const result = resolveSkillSource(
      "https://github.com/vercel-labs/skills/tree/main/skills/find-skills",
    );
    expect(result).toEqual({
      owner: "vercel-labs",
      repo: "skills",
      skillSlug: "find-skills",
      ref: "main",
    });
  });

  test("parses full GitHub URL with non-main branch", () => {
    const result = resolveSkillSource(
      "https://github.com/some-org/repo/tree/develop/skills/my-skill",
    );
    expect(result).toEqual({
      owner: "some-org",
      repo: "repo",
      skillSlug: "my-skill",
      ref: "develop",
    });
  });

  test("parses GitHub URL with trailing slash", () => {
    const result = resolveSkillSource(
      "https://github.com/owner/repo/tree/main/skills/skill-name/",
    );
    expect(result).toEqual({
      owner: "owner",
      repo: "repo",
      skillSlug: "skill-name",
      ref: "main",
    });
  });

  test("throws on bare skill name (no owner/repo)", () => {
    expect(() => resolveSkillSource("find-skills")).toThrow(
      'Invalid skill source "find-skills"',
    );
  });

  test("throws on empty string", () => {
    expect(() => resolveSkillSource("")).toThrow('Invalid skill source ""');
  });

  test("throws on owner-only format", () => {
    expect(() => resolveSkillSource("vercel-labs")).toThrow(
      'Invalid skill source "vercel-labs"',
    );
  });

  test("throws on owner/repo without skill", () => {
    expect(() => resolveSkillSource("vercel-labs/skills")).toThrow(
      'Invalid skill source "vercel-labs/skills"',
    );
  });

  test("rejects path traversal in @ format slug", () => {
    expect(() => resolveSkillSource("owner/repo@../../malicious")).toThrow(
      'Invalid skill source "owner/repo@../../malicious"',
    );
  });

  test("rejects uppercase slug in @ format", () => {
    expect(() => resolveSkillSource("owner/repo@BadSlug")).toThrow(
      'Invalid skill source "owner/repo@BadSlug"',
    );
  });
});

// ─── validateSkillSlug ──────────────────────────────────────────────────────

describe("validateSkillSlug", () => {
  test("accepts valid slugs", () => {
    expect(() => validateSkillSlug("my-skill")).not.toThrow();
    expect(() => validateSkillSlug("skill123")).not.toThrow();
    expect(() => validateSkillSlug("my.skill")).not.toThrow();
    expect(() => validateSkillSlug("my_skill")).not.toThrow();
  });

  test("rejects path traversal characters", () => {
    expect(() => validateSkillSlug("../../malicious")).toThrow(
      "path traversal",
    );
    expect(() => validateSkillSlug("foo/bar")).toThrow("path traversal");
    expect(() => validateSkillSlug("foo\\bar")).toThrow("path traversal");
  });

  test("rejects slugs starting with special chars", () => {
    expect(() => validateSkillSlug(".hidden")).toThrow();
    expect(() => validateSkillSlug("-dash")).toThrow();
  });

  test("rejects empty input", () => {
    expect(() => validateSkillSlug("")).toThrow("Skill slug is required");
  });
});

// ─── fetchSkillFromGitHub ───────────────────────────────────────────────────

describe("fetchSkillFromGitHub", () => {
  test("fetches from conventional skills/<slug>/ path", async () => {
    mockFetchImpl = (url: string | URL | Request) => {
      const urlStr = url.toString();
      // Probe request for skills/my-skill
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
      // File download
      if (urlStr.includes("raw.example.com/SKILL.md")) {
        return Promise.resolve(new Response("# My Skill", { status: 200 }));
      }
      return Promise.resolve(new Response("not found", { status: 404 }));
    };

    const files = await fetchSkillFromGitHub("owner", "repo", "my-skill");
    expect(files["SKILL.md"]).toBe("# My Skill");
  });

  test("falls back to tree search when skills/<slug>/ returns 404", async () => {
    mockFetchImpl = (url: string | URL | Request) => {
      const urlStr = url.toString();
      // Probe for conventional path returns 404
      if (urlStr.includes("/contents/skills/csv")) {
        return Promise.resolve(new Response("Not Found", { status: 404 }));
      }
      // Tree search returns the skill at a non-standard path
      if (urlStr.includes("/git/trees/")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              tree: [
                { path: "examples/skills/csv/SKILL.md", type: "blob" },
                { path: "examples/skills/csv/scripts/filter.sh", type: "blob" },
                { path: "README.md", type: "blob" },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        );
      }
      // Subdirectory listing (must precede parent path check — both use
      // .includes() and the parent path is a prefix of this one)
      if (urlStr.includes("/contents/examples/skills/csv/scripts")) {
        return Promise.resolve(
          new Response(
            JSON.stringify([
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
                name: "scripts",
                type: "dir",
                download_url: null,
              },
            ]),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        );
      }
      // File downloads
      if (urlStr.includes("raw.example.com/SKILL.md")) {
        return Promise.resolve(new Response("# CSV Skill", { status: 200 }));
      }
      if (urlStr.includes("raw.example.com/filter.sh")) {
        return Promise.resolve(
          new Response("#!/bin/bash\necho filter", { status: 200 }),
        );
      }
      return Promise.resolve(new Response("not found", { status: 404 }));
    };

    const files = await fetchSkillFromGitHub("vercel-labs", "bash-tool", "csv");
    expect(files["SKILL.md"]).toBe("# CSV Skill");
    expect(files["scripts/filter.sh"]).toBe("#!/bin/bash\necho filter");
  });

  test("throws when skill not found in tree either", async () => {
    mockFetchImpl = (url: string | URL | Request) => {
      const urlStr = url.toString();
      if (urlStr.includes("/contents/skills/missing")) {
        return Promise.resolve(new Response("Not Found", { status: 404 }));
      }
      if (urlStr.includes("/git/trees/")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({ tree: [{ path: "README.md", type: "blob" }] }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        );
      }
      return Promise.resolve(new Response("not found", { status: 404 }));
    };

    await expect(
      fetchSkillFromGitHub("owner", "repo", "missing"),
    ).rejects.toThrow("Searched skills/missing/ and the full repo tree");
  });
});
