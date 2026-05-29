import { describe, expect, it, mock } from "bun:test";

import { listPackageSkills } from "../skills/skillssh-package-discovery.js";
import type { GitHubTreeEntry } from "../skills/skillssh-registry.js";

// Mock fetch globally for testing
const originalFetch = global.fetch;

describe("listPackageSkills", () => {
  it("discovers skills in the conventional skills/ layout", async () => {
    const mockFetch = mock((url: string) => {
      // Match the directory listing for `skills/`. The impl URL is either
      // `.../contents/skills` (no ref) or `.../contents/skills?ref=…` (with ref).
      const isSkillsDirListing =
        url.endsWith("/contents/skills") ||
        url.includes("/contents/skills?");
      if (isSkillsDirListing) {
        // Directory listing for skills/
        return Promise.resolve(
          new Response(
            JSON.stringify([
              { name: "brainstorming", type: "dir" },
              { name: "outlining", type: "dir" },
              { name: "README.md", type: "file" },
            ]),
            { status: 200 },
          ),
        );
      }

      if (url.includes("/contents/skills/brainstorming/SKILL.md")) {
        return Promise.resolve(new Response("# Brainstorming", { status: 200 }));
      }

      if (url.includes("/contents/skills/outlining/SKILL.md")) {
        return Promise.resolve(new Response("# Outlining", { status: 200 }));
      }

      return Promise.resolve(new Response("Not found", { status: 404 }));
    });

    global.fetch = mockFetch as unknown as typeof fetch;

    try {
      const skills = await listPackageSkills("obra", "superpowers");

      expect(skills).toHaveLength(2);
      expect(skills[0]).toEqual({
        slug: "brainstorming",
        dirPath: "skills/brainstorming",
      });
      expect(skills[1]).toEqual({
        slug: "outlining",
        dirPath: "skills/outlining",
      });
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("falls back to tree walk when skills/ dir doesn't exist", async () => {
    const mockFetch = mock((url: string) => {
      if (url.includes("/contents/skills")) {
        // Conventional path returns 404
        return Promise.resolve(new Response("Not found", { status: 404 }));
      }

      if (url.includes("/git/trees/")) {
        // Tree walk response
        return Promise.resolve(
          new Response(
            JSON.stringify({
              tree: [
                { path: "tools/brainstorming/SKILL.md", type: "blob" },
                { path: "tools/outlining/SKILL.md", type: "blob" },
              ] as GitHubTreeEntry[],
            }),
            { status: 200 },
          ),
        );
      }

      return Promise.resolve(new Response("Not found", { status: 404 }));
    });

    global.fetch = mockFetch as unknown as typeof fetch;

    try {
      const skills = await listPackageSkills("vercel-labs", "agent-skills");

      expect(skills).toHaveLength(2);
      expect(skills[0]?.slug).toBe("brainstorming");
      expect(skills[1]?.slug).toBe("outlining");
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("returns empty array when no skills are found", async () => {
    const mockFetch = mock((url: string) => {
      if (url.includes("/contents/skills")) {
        return Promise.resolve(new Response("Not found", { status: 404 }));
      }

      if (url.includes("/git/trees/")) {
        // Empty tree
        return Promise.resolve(
          new Response(JSON.stringify({ tree: [] }), { status: 200 }),
        );
      }

      return Promise.resolve(new Response("Not found", { status: 404 }));
    });

    global.fetch = mockFetch as unknown as typeof fetch;

    try {
      const skills = await listPackageSkills("empty-org", "empty-repo");
      expect(skills).toHaveLength(0);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("rejects nested skills (depth > 4)", async () => {
    const mockFetch = mock((url: string) => {
      if (url.includes("/contents/skills")) {
        return Promise.resolve(new Response("Not found", { status: 404 }));
      }

      if (url.includes("/git/trees/")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              tree: [
                // Valid: depth 2
                { path: "tools/brainstorming/SKILL.md", type: "blob" },
                // Too deep: depth 5 (a/b/c/d/e/SKILL.md)
                {
                  path: "examples/v1/tools/deep/nested/SKILL.md",
                  type: "blob",
                },
              ] as GitHubTreeEntry[],
            }),
            { status: 200 },
          ),
        );
      }

      return Promise.resolve(new Response("Not found", { status: 404 }));
    });

    global.fetch = mockFetch as unknown as typeof fetch;

    try {
      const skills = await listPackageSkills("test-org", "test-repo");

      // Should only include the shallower one
      expect(skills).toHaveLength(1);
      expect(skills[0]?.slug).toBe("brainstorming");
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("includes ref parameter when provided", async () => {
    const mockFetch = mock((url: string) => {
      if (url.includes("/contents/skills") && url.includes("ref=v1.0.0")) {
        return Promise.resolve(
          new Response(
            JSON.stringify([{ name: "feature", type: "dir" }]),
            { status: 200 },
          ),
        );
      }

      if (url.includes("/SKILL.md") && url.includes("ref=v1.0.0")) {
        return Promise.resolve(new Response("# Feature", { status: 200 }));
      }

      if (url.includes("/contents/skills") && !url.includes("ref=")) {
        return Promise.resolve(new Response("Not found", { status: 404 }));
      }

      return Promise.resolve(new Response("Not found", { status: 404 }));
    });

    global.fetch = mockFetch as unknown as typeof fetch;

    try {
      const skills = await listPackageSkills("obra", "superpowers", "v1.0.0");

      expect(skills).toHaveLength(1);
      expect(skills[0]?.slug).toBe("feature");
    } finally {
      global.fetch = originalFetch;
    }
  });
});
