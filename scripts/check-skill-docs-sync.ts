#!/usr/bin/env bun
/**
 * Skill ↔ public-docs drift tripwire.
 *
 * The behavioral source of truth for a bundled skill is its SKILL.md
 * (assistant/src/config/bundled-skills/<skill>/SKILL.md). The public reference
 * page for that skill lives in a *separate* repo (vellum-assistant-platform,
 * served at https://www.vellum.ai/docs/skills-reference/<slug>). The two are
 * authored by hand and drift silently.
 *
 * This check records a content fingerprint of each documented skill's SKILL.md
 * in scripts/skill-docs-sync.manifest.json. When a SKILL.md changes, the
 * recorded fingerprint no longer matches and the check fails, naming the public
 * page that may now be stale.
 *
 * It cannot prove the cross-repo docs page was updated — it forces a human to
 * confront the question. The workflow is: change a SKILL.md → review the public
 * page → re-record the fingerprint with `--write`. The fingerprint bump is the
 * acknowledgement, and it leaves a reviewable trail in the diff. A trivial
 * wording edit still requires a bump; that friction is the point.
 *
 * Usage:
 *   bun run scripts/check-skill-docs-sync.ts            # check (CI / guard test)
 *   bun run scripts/check-skill-docs-sync.ts --write    # re-record fingerprints
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const MANIFEST_PATH = join(SCRIPT_DIR, "skill-docs-sync.manifest.json");
const BUNDLED_SKILLS_DIR = join(
  REPO_ROOT,
  "assistant",
  "src",
  "config",
  "bundled-skills",
);
const DOCS_BASE_URL = "https://www.vellum.ai/docs/skills-reference";

interface SkillEntry {
  /** Slug of the public docs page (path segment under /skills-reference/). */
  docsSlug: string;
  /** sha256 of the normalized SKILL.md, recorded at last docs reconciliation. */
  sha256: string;
}

interface Manifest {
  note: string;
  skills: Record<string, SkillEntry>;
}

/**
 * Normalize SKILL.md before hashing so the fingerprint only moves on meaningful
 * content changes, not line-ending or trailing-whitespace churn: LF endings,
 * per-line trailing whitespace stripped, exactly one trailing newline.
 */
function normalize(content: string): string {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  return (
    lines
      .map((line) => line.replace(/[ \t]+$/g, ""))
      .join("\n")
      .replace(/\n+$/g, "") + "\n"
  );
}

function fingerprint(skillDir: string): { hash: string } | { missing: true } {
  const path = join(BUNDLED_SKILLS_DIR, skillDir, "SKILL.md");
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch {
    return { missing: true };
  }
  return {
    hash: createHash("sha256").update(normalize(content)).digest("hex"),
  };
}

function loadManifest(): Manifest {
  return JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as Manifest;
}

function saveManifest(manifest: Manifest): void {
  writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + "\n");
}

function docsUrl(slug: string): string {
  return `${DOCS_BASE_URL}/${slug}`;
}

function main(): void {
  const write =
    process.argv.includes("--write") || process.argv.includes("--update");
  const manifest = loadManifest();
  const skillDirs = Object.keys(manifest.skills).sort();

  if (write) {
    let changed = 0;
    for (const skillDir of skillDirs) {
      const fp = fingerprint(skillDir);
      if ("missing" in fp) {
        console.error(
          `✖ ${skillDir}: SKILL.md not found at assistant/src/config/bundled-skills/${skillDir}/SKILL.md`,
        );
        process.exit(1);
      }
      if (manifest.skills[skillDir].sha256 !== fp.hash) changed++;
      manifest.skills[skillDir].sha256 = fp.hash;
    }
    saveManifest(manifest);
    console.log(
      `Recorded fingerprints for ${skillDirs.length} skill(s); ${changed} updated.`,
    );
    return;
  }

  const missing: string[] = [];
  const drifted: { skillDir: string; slug: string }[] = [];

  for (const skillDir of skillDirs) {
    const entry = manifest.skills[skillDir];
    const fp = fingerprint(skillDir);
    if ("missing" in fp) {
      missing.push(skillDir);
      continue;
    }
    if (!entry.sha256 || entry.sha256 !== fp.hash) {
      drifted.push({ skillDir, slug: entry.docsSlug });
    }
  }

  if (missing.length === 0 && drifted.length === 0) {
    console.log(
      `✓ All ${skillDirs.length} documented skill(s) match their recorded fingerprint.`,
    );
    return;
  }

  if (missing.length > 0) {
    console.error(
      "✖ SKILL.md missing for manifest entries (renamed or removed?):",
    );
    for (const skillDir of missing) console.error(`    - ${skillDir}`);
    console.error(
      "  Update scripts/skill-docs-sync.manifest.json to match the new skill name.\n",
    );
  }

  if (drifted.length > 0) {
    console.error(
      "✖ SKILL.md changed since the public docs were last reconciled:\n",
    );
    for (const { skillDir, slug } of drifted) {
      console.error(`    - ${skillDir}  →  ${docsUrl(slug)}`);
    }
    console.error(
      [
        "",
        "  These skills' behavior may have changed without their public reference page.",
        "  For each one:",
        "    1. Review the docs page above (it lives in vellum-assistant-platform:",
        "       web/src/app/(marketing)/docs/_components/skills-reference-<slug>-content.tsx)",
        "       and update it if the behavior changed.",
        "    2. Re-record the fingerprint to acknowledge it is reconciled:",
        "         bun run scripts/check-skill-docs-sync.ts --write",
        "",
      ].join("\n"),
    );
  }

  process.exit(1);
}

main();
