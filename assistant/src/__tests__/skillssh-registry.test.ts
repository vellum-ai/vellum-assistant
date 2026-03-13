import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type {
  AuditResponse,
  SkillAuditData,
  SkillsShSearchResult,
} from "../skills/skillssh-registry.js";
import {
  fetchSkillAudits,
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
  ) as typeof fetch;
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
        new Response(JSON.stringify(mockResults), {
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
        new Response(JSON.stringify([]), {
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
      Promise.resolve(
        new Response("Internal Server Error", { status: 500 }),
      );

    await expect(
      fetchSkillAudits("some/source", ["slug"]),
    ).rejects.toThrow("Audit fetch failed: HTTP 500");
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
    expect(() =>
      resolveSkillSource("owner/repo@../../malicious"),
    ).toThrow('Invalid skill source "owner/repo@../../malicious"');
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
