import { existsSync } from "node:fs";
import { join } from "node:path";

import type { Command } from "commander";

import type { CatalogSkill } from "../../skills/catalog-install.js";
import {
  fetchCatalog,
  getRepoSkillsDir,
  installSkillLocally,
  readLocalCatalog,
  uninstallSkillLocally,
} from "../../skills/catalog-install.js";
import type {
  AuditResponse,
  SkillsShSearchResult,
} from "../../skills/skillssh-registry.js";
import {
  fetchSkillAudits,
  formatAuditBadges,
  installExternalSkill,
  resolveSkillSource,
  searchSkillsRegistry,
} from "../../skills/skillssh-registry.js";
import { getWorkspaceSkillsDir } from "../../util/platform.js";
import { log } from "../logger.js";

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

export function registerSkillsCommand(program: Command): void {
  const skills = program
    .command("skills")
    .description("Browse and install skills from the Vellum catalog");

  skills.addHelpText(
    "after",
    `
Manage skills from the Vellum catalog. Skills extend the assistant's
capabilities with pre-built workflows and tools.

Examples:
  $ assistant skills list
  $ assistant skills list --json
  $ assistant skills search react
  $ assistant skills search react --limit 5 --json
  $ assistant skills install weather
  $ assistant skills install weather --overwrite
  $ assistant skills uninstall weather
  $ assistant skills add vercel-labs/skills@find-skills
  $ assistant skills add vercel-labs/skills/find-skills --overwrite`,
  );

  skills
    .command("list")
    .description("List available catalog skills")
    .option("--json", "Machine-readable JSON output")
    .action(async (opts: { json?: boolean }) => {
      try {
        // In dev mode, use the local catalog as the source of truth
        // and skip the remote Platform API entirely.
        const repoSkillsDir = getRepoSkillsDir();
        let catalog: CatalogSkill[];
        if (repoSkillsDir) {
          catalog = readLocalCatalog(repoSkillsDir);
        } else {
          catalog = await fetchCatalog();
        }

        if (opts.json) {
          console.log(JSON.stringify({ ok: true, skills: catalog }));
          return;
        }

        if (catalog.length === 0) {
          log.info("No skills available in the catalog.");
          return;
        }

        log.info(`Available skills (${catalog.length}):\n`);
        for (const s of catalog) {
          const emoji = s.emoji ? `${s.emoji} ` : "";
          const deps = s.includes?.length
            ? ` (requires: ${s.includes.join(", ")})`
            : "";
          log.info(`  ${emoji}${s.id}`);
          log.info(`    ${s.name} — ${s.description}${deps}`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (opts.json) {
          console.log(JSON.stringify({ ok: false, error: msg }));
        } else {
          log.error(`Error: ${msg}`);
        }
        process.exitCode = 1;
      }
    });

  skills
    .command("search <query>")
    .description("Search the Vellum catalog and skills.sh community registry")
    .option("--limit <n>", "Maximum number of community results", "10")
    .option("--json", "Machine-readable JSON output")
    .addHelpText(
      "after",
      `
Arguments:
  query    Free-text search term matched against skill names, descriptions,
           and tags. Searches the Vellum catalog first, then the skills.sh
           community registry.

Displays results from both sources with clear labels. When a skill ID
exists in both the Vellum catalog and the community registry, a conflict
note is shown with guidance on which install command to use.

Examples:
  $ assistant skills search react
  $ assistant skills search "file management" --limit 3
  $ assistant skills search deploy --json`,
    )
    .action(async (query: string, opts: { limit: string; json?: boolean }) => {
      const json = opts.json ?? false;
      const limit = parseInt(opts.limit, 10) || 10;

      try {
        // ── Vellum catalog search ────────────────────────────────────
        const repoSkillsDir = getRepoSkillsDir();
        let catalog: CatalogSkill[];
        if (repoSkillsDir) {
          catalog = readLocalCatalog(repoSkillsDir);
        } else {
          try {
            catalog = await fetchCatalog();
          } catch {
            catalog = [];
          }
        }

        const lowerQuery = query.toLowerCase();
        const catalogMatches = catalog.filter(
          (s) =>
            s.id.toLowerCase().includes(lowerQuery) ||
            s.name.toLowerCase().includes(lowerQuery) ||
            s.description.toLowerCase().includes(lowerQuery),
        );

        // ── Community registry search (non-fatal on failure) ─────────
        let registryResults: SkillsShSearchResult[] = [];
        let registryError: string | undefined;
        try {
          registryResults = await searchSkillsRegistry(query, limit);
        } catch (err) {
          registryError = err instanceof Error ? err.message : String(err);
        }

        // ── Conflict detection ───────────────────────────────────────
        const catalogIds = new Set(catalogMatches.map((s) => s.id));
        const conflictIds = new Set(
          registryResults
            .filter((r) => catalogIds.has(r.skillId))
            .map((r) => r.skillId),
        );

        if (catalogMatches.length === 0 && registryResults.length === 0) {
          if (json) {
            console.log(
              JSON.stringify({
                ok: true,
                catalog: [],
                community: [],
                audits: {},
                ...(registryError ? { registryError } : {}),
              }),
            );
          } else {
            log.info(`No skills found for "${query}".`);
            if (registryError) {
              log.warn(`(skills.sh registry unavailable: ${registryError})`);
            }
          }
          return;
        }

        // ── Fetch audits for community results ───────────────────────
        const allAudits: AuditResponse = {};
        if (registryResults.length > 0) {
          const sourceToSlugs = new Map<string, string[]>();
          for (const r of registryResults) {
            const slugs = sourceToSlugs.get(r.source) ?? [];
            slugs.push(r.skillId);
            sourceToSlugs.set(r.source, slugs);
          }
          for (const [source, slugs] of sourceToSlugs) {
            try {
              const audits = await fetchSkillAudits(source, slugs);
              for (const [skillId, auditData] of Object.entries(audits)) {
                allAudits[`${source}/${skillId}`] = auditData;
              }
            } catch {
              // Audit fetch failures are non-fatal
            }
          }
        }

        if (json) {
          console.log(
            JSON.stringify({
              ok: true,
              catalog: catalogMatches,
              community: registryResults,
              audits: allAudits,
              ...(registryError ? { registryError } : {}),
            }),
          );
          return;
        }

        // ── Installed-state detection ─────────────────────────────────
        const skillsDir = getWorkspaceSkillsDir();
        const isInstalled = (id: string) =>
          existsSync(join(skillsDir, id, "SKILL.md"));

        // ── Display catalog results ──────────────────────────────────
        if (catalogMatches.length > 0) {
          log.info(`Vellum catalog (${catalogMatches.length}):\n`);
          for (const s of catalogMatches) {
            const emoji = s.emoji ? `${s.emoji} ` : "";
            const installed = isInstalled(s.id);
            const badge = installed ? " [installed]" : "";
            log.info(`  ${emoji}${s.name}${badge}`);
            if (s.name !== s.id) {
              log.info(`    ID: ${s.id}`);
            }
            log.info(`    Description: ${s.description}`);
            log.info(`    Install: assistant skills install ${s.id}`);
            if (conflictIds.has(s.id)) {
              log.info(`    NOTE: Also found in community registry`);
            }
            log.info("");
          }
        }

        // ── Display community results ────────────────────────────────
        if (registryResults.length > 0) {
          log.info(`Community registry (${registryResults.length}):\n`);
          for (const r of registryResults) {
            const installed = isInstalled(r.skillId);
            const badge = installed ? " [installed]" : "";
            log.info(`  ${r.name}${badge}`);
            if (r.name !== r.skillId) {
              log.info(`    ID: ${r.skillId}`);
            }
            log.info(`    Source: ${r.source}`);
            log.info(`    Installs: ${r.installs}`);
            const auditData = allAudits[`${r.source}/${r.skillId}`];
            if (auditData) {
              log.info(`    ${formatAuditBadges(auditData)}`);
            } else {
              log.info("    Security: no audit data");
            }
            log.info(
              `    Install: assistant skills add ${r.source}@${r.skillId}`,
            );
            if (conflictIds.has(r.skillId)) {
              log.info(`    NOTE: Conflicts with Vellum catalog skill`);
            }
            log.info("");
          }
        } else if (registryError) {
          log.warn(`\n(skills.sh registry unavailable: ${registryError})`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (json) {
          console.log(JSON.stringify({ ok: false, error: msg }));
        } else {
          log.error(`Error: ${msg}`);
        }
        process.exitCode = 1;
      }
    });

  skills
    .command("install <skill-id>")
    .description("Install a skill from the catalog")
    .option("--overwrite", "Replace an already installed skill")
    .option("--json", "Machine-readable JSON output")
    .action(
      async (
        skillId: string,
        opts: { overwrite?: boolean; json?: boolean },
      ) => {
        const json = opts.json ?? false;

        try {
          // In dev mode, also check the repo-local skills/ directory
          const repoSkillsDir = getRepoSkillsDir();
          let localSkills: CatalogSkill[] = [];
          if (repoSkillsDir) {
            localSkills = readLocalCatalog(repoSkillsDir);
          }

          // Check local catalog first, then fall back to remote
          let entry = localSkills.find((s) => s.id === skillId);
          if (!entry) {
            const catalog = await fetchCatalog();
            entry = catalog.find((s) => s.id === skillId);
          }

          if (!entry) {
            throw new Error(
              `Skill "${skillId}" not found in the Vellum catalog`,
            );
          }

          // Fetch, extract, and install
          await installSkillLocally(skillId, entry, opts.overwrite ?? false);

          if (json) {
            console.log(JSON.stringify({ ok: true, skillId }));
          } else {
            log.info(`Installed skill "${skillId}".`);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (json) {
            console.log(JSON.stringify({ ok: false, error: msg }));
          } else {
            log.error(`Error: ${msg}`);
          }
          process.exitCode = 1;
        }
      },
    );

  skills
    .command("uninstall <skill-id>")
    .description("Uninstall a previously installed skill")
    .option("--json", "Machine-readable JSON output")
    .action(async (skillId: string, opts: { json?: boolean }) => {
      const json = opts.json ?? false;

      try {
        uninstallSkillLocally(skillId);

        if (json) {
          console.log(JSON.stringify({ ok: true, skillId }));
        } else {
          log.info(`Uninstalled skill "${skillId}".`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (json) {
          console.log(JSON.stringify({ ok: false, error: msg }));
        } else {
          log.error(`Error: ${msg}`);
        }
        process.exitCode = 1;
      }
    });

  skills
    .command("add <source>")
    .description(
      "Install a community skill from the skills.sh registry (GitHub)",
    )
    .option("--overwrite", "Replace an already installed skill")
    .option("--json", "Machine-readable JSON output")
    .addHelpText(
      "after",
      `
Arguments:
  source   Skill source in one of these formats:
             owner/repo@skill-name
             owner/repo/skill-name
             https://github.com/owner/repo/tree/<branch>/skills/skill-name

Notes:
  Fetches the skill's SKILL.md and supporting files from the specified GitHub
  repository and installs them into the workspace skills directory. A
  version.json file is written with origin metadata for provenance tracking.

Examples:
  $ assistant skills add vercel-labs/skills@find-skills
  $ assistant skills add vercel-labs/skills/find-skills
  $ assistant skills add vercel-labs/skills@find-skills --overwrite`,
    )
    .action(
      async (source: string, opts: { overwrite?: boolean; json?: boolean }) => {
        const json = opts.json ?? false;

        try {
          const { owner, repo, skillSlug, ref } = resolveSkillSource(source);

          await installExternalSkill(
            owner,
            repo,
            skillSlug,
            opts.overwrite ?? false,
            ref,
          );

          if (json) {
            console.log(
              JSON.stringify({
                ok: true,
                skillSlug,
                source: `${owner}/${repo}`,
              }),
            );
          } else {
            log.info(`Installed skill "${skillSlug}" from ${owner}/${repo}.`);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (json) {
            console.log(JSON.stringify({ ok: false, error: msg }));
          } else {
            log.error(`Error: ${msg}`);
          }
          process.exitCode = 1;
        }
      },
    );
}
