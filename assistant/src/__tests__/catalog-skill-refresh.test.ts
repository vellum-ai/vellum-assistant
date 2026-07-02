/**
 * Staleness refresh for catalog-installed skills.
 *
 * Installed catalog skills load with user-skill precedence and previously
 * stayed frozen at install time — a published skill fix never reached
 * assistants that already had the skill. `refreshInstalledSkillIfStale`
 * refreshes a pristine, vellum-origin install when the catalog entry is
 * newer, and must never overwrite user-modified or non-catalog installs.
 */
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { invalidateCatalogCache } from "../skills/catalog-cache.js";
import type { CatalogSkill } from "../skills/catalog-install.js";
import { mergeCatalogsPreferFresh } from "../skills/catalog-merge.js";
import { refreshInstalledSkillIfStale } from "../skills/catalog-refresh.js";
import {
  computeSkillHash,
  readInstallMeta,
  type SkillInstallMeta,
  writeInstallMeta,
} from "../skills/install-meta.js";
import { makeTar } from "./helpers/tar-fixtures.js";

const OLD_STAMP = "2026-07-01T00:00:00.000Z";
const NEW_STAMP = "2026-07-02T00:00:00.000Z";

const originalWorkspaceDir = process.env.VELLUM_WORKSPACE_DIR;
const originalVellumDev = process.env.VELLUM_DEV;
const originalFetch = globalThis.fetch;

let workspaceDir: string;

function skillMarkdown(body: string): string {
  return `---
name: "demo-skill"
description: "A test skill."
---

${body}
`;
}

/** Write an installed skill with a pristine (matching) content hash. */
function writeInstalledSkill(
  body: string,
  metaOverrides: Partial<SkillInstallMeta> = {},
): string {
  const skillDir = join(workspaceDir, "skills", "demo-skill");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), skillMarkdown(body));
  writeInstallMeta(skillDir, {
    origin: "vellum",
    installedAt: OLD_STAMP,
    catalogUpdatedAt: OLD_STAMP,
    author: "user",
    contentHash: computeSkillHash(skillDir) ?? undefined,
    ...metaOverrides,
  });
  return skillDir;
}

/** Mock the platform API: catalog listing plus the skill tarball. */
function mockPlatform(catalogUpdatedAt: string, newBody: string): void {
  const archive = gzipSync(
    makeTar([{ name: "SKILL.md", content: skillMarkdown(newBody) }]),
  );
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith("/v1/skills/")) {
      return Response.json({
        skills: [
          {
            id: "demo-skill",
            name: "demo-skill",
            description: "A test skill.",
            updatedAt: catalogUpdatedAt,
          },
        ],
      });
    }
    if (url.includes("/v1/skills/demo-skill")) {
      return new Response(archive);
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "catalog-refresh-"));
  process.env.VELLUM_WORKSPACE_DIR = workspaceDir;
  // Keep getRepoSkillsDir() out of play so installs come from the mocked
  // platform, not the real repo skills/ tree.
  delete process.env.VELLUM_DEV;
  mkdirSync(join(workspaceDir, "skills"), { recursive: true });
  invalidateCatalogCache();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  invalidateCatalogCache();
  if (originalWorkspaceDir === undefined) {
    delete process.env.VELLUM_WORKSPACE_DIR;
  } else {
    process.env.VELLUM_WORKSPACE_DIR = originalWorkspaceDir;
  }
  if (originalVellumDev !== undefined) {
    process.env.VELLUM_DEV = originalVellumDev;
  }
  rmSync(workspaceDir, { recursive: true, force: true });
});

describe("refreshInstalledSkillIfStale", () => {
  test("refreshes a pristine install when the catalog entry is newer", async () => {
    const skillDir = writeInstalledSkill("Old body.");
    mockPlatform(NEW_STAMP, "New body.");

    const outcome = await refreshInstalledSkillIfStale("demo-skill");

    expect(outcome).toBe("refreshed");
    expect(readFileSync(join(skillDir, "SKILL.md"), "utf-8")).toContain(
      "New body.",
    );
    // Provenance advances to the catalog stamp of the installed content, so
    // the next check reports fresh instead of refreshing again.
    const meta = readInstallMeta(skillDir);
    expect(meta?.catalogUpdatedAt).toBe(NEW_STAMP);
    expect(meta?.contentHash).toBe(computeSkillHash(skillDir)!);
    expect(await refreshInstalledSkillIfStale("demo-skill")).toBe("fresh");
  });

  test("reports fresh when the catalog entry is not newer", async () => {
    const skillDir = writeInstalledSkill("Current body.");
    mockPlatform(OLD_STAMP, "Should never install.");

    expect(await refreshInstalledSkillIfStale("demo-skill")).toBe("fresh");
    expect(readFileSync(join(skillDir, "SKILL.md"), "utf-8")).toContain(
      "Current body.",
    );
  });

  test("never overwrites a locally modified install", async () => {
    const skillDir = writeInstalledSkill("Old body.");
    writeFileSync(
      join(skillDir, "SKILL.md"),
      skillMarkdown("User-edited body."),
    );
    mockPlatform(NEW_STAMP, "New body.");

    expect(await refreshInstalledSkillIfStale("demo-skill")).toBe(
      "skipped_locally_modified",
    );
    expect(readFileSync(join(skillDir, "SKILL.md"), "utf-8")).toContain(
      "User-edited body.",
    );
  });

  test("skips non-catalog-managed installs", async () => {
    writeInstalledSkill("Old body.", { origin: "skillssh" });
    mockPlatform(NEW_STAMP, "New body.");

    expect(await refreshInstalledSkillIfStale("demo-skill")).toBe(
      "skipped_not_catalog_managed",
    );
  });

  test("skips installs with no recorded content hash", async () => {
    writeInstalledSkill("Old body.", { contentHash: undefined });
    mockPlatform(NEW_STAMP, "New body.");

    expect(await refreshInstalledSkillIfStale("demo-skill")).toBe(
      "skipped_no_recorded_hash",
    );
  });

  test("skips skills that are not installed", async () => {
    mockPlatform(NEW_STAMP, "New body.");

    expect(await refreshInstalledSkillIfStale("demo-skill")).toBe(
      "skipped_not_installed",
    );
  });

  test("skips when the catalog has no entry for the skill", async () => {
    writeInstalledSkill("Old body.");
    globalThis.fetch = (async () =>
      Response.json({ skills: [] })) as unknown as typeof fetch;

    expect(await refreshInstalledSkillIfStale("demo-skill")).toBe(
      "skipped_no_catalog_entry",
    );
  });

  test("preserves a user edit made mid-refresh (during the fetch/stage window)", async () => {
    const skillDir = writeInstalledSkill("Old body.");
    const archive = gzipSync(
      makeTar([{ name: "SKILL.md", content: skillMarkdown("New body.") }]),
    );
    // Simulate a user editing the skill after the pristineness check passes
    // but before the swap: mutate the on-disk copy when the tarball is fetched.
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.endsWith("/v1/skills/")) {
        return Response.json({
          skills: [{ id: "demo-skill", updatedAt: NEW_STAMP }],
        });
      }
      if (url.includes("/v1/skills/demo-skill")) {
        writeFileSync(
          join(skillDir, "SKILL.md"),
          skillMarkdown("User edit during refresh."),
        );
        return new Response(archive);
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;

    expect(await refreshInstalledSkillIfStale("demo-skill")).toBe(
      "skipped_locally_modified",
    );
    // The user's mid-flight edit survives; the refresh did not clobber it.
    expect(readFileSync(join(skillDir, "SKILL.md"), "utf-8")).toContain(
      "User edit during refresh.",
    );
  });

  test("falls back to installedAt for installs that predate catalogUpdatedAt", async () => {
    const skillDir = writeInstalledSkill("Old body.", {
      catalogUpdatedAt: undefined,
    });
    mockPlatform(NEW_STAMP, "New body.");

    expect(await refreshInstalledSkillIfStale("demo-skill")).toBe("refreshed");
    expect(readFileSync(join(skillDir, "SKILL.md"), "utf-8")).toContain(
      "New body.",
    );
  });

  test("detects an install made from a stale source via catalogUpdatedAt", async () => {
    // Installed recently (installedAt in the future of the catalog entry)
    // but from a source whose content predates the current catalog entry —
    // the recorded catalogUpdatedAt, not the install wall-clock, decides.
    const skillDir = writeInstalledSkill("Old body.", {
      installedAt: "2026-07-03T00:00:00.000Z",
      catalogUpdatedAt: OLD_STAMP,
    });
    mockPlatform(NEW_STAMP, "New body.");

    expect(await refreshInstalledSkillIfStale("demo-skill")).toBe("refreshed");
    expect(readFileSync(join(skillDir, "SKILL.md"), "utf-8")).toContain(
      "New body.",
    );
  });
});

describe("mergeCatalogsPreferFresh", () => {
  const entry = (
    id: string,
    updatedAt: string | undefined,
    description: string,
  ): CatalogSkill => ({
    id,
    name: id,
    description,
    ...(updatedAt ? { updatedAt } : {}),
  });

  test("newer remote entry replaces the local one", () => {
    const merged = mergeCatalogsPreferFresh(
      [entry("a", OLD_STAMP, "local")],
      [entry("a", NEW_STAMP, "remote")],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0].description).toBe("remote");
  });

  test("local entry wins ties and newer-local conflicts", () => {
    const merged = mergeCatalogsPreferFresh(
      [entry("a", NEW_STAMP, "local"), entry("b", OLD_STAMP, "local")],
      [entry("a", OLD_STAMP, "remote"), entry("b", OLD_STAMP, "remote")],
    );
    expect(merged.map((s) => s.description)).toEqual(["local", "local"]);
  });

  test("missing timestamps keep the local entry; remote-only entries append", () => {
    const merged = mergeCatalogsPreferFresh(
      [entry("a", undefined, "local")],
      [entry("a", undefined, "remote"), entry("b", NEW_STAMP, "remote")],
    );
    expect(merged.map((s) => `${s.id}:${s.description}`)).toEqual([
      "a:local",
      "b:remote",
    ]);
  });
});
