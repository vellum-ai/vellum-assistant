import { existsSync } from "node:fs";
import { join } from "node:path";

import type { Command } from "commander";

import { getConfig } from "../../config/loader.js";
import { resolveSkillStates } from "../../config/skill-state.js";
import { loadSkillCatalog } from "../../config/skills.js";
import type { CatalogSkill } from "../../skills/catalog-install.js";
import {
  fetchCatalog,
  getRepoSkillsDir,
  installSkillLocally,
  readLocalCatalog,
  uninstallSkillLocally,
} from "../../skills/catalog-install.js";
import { filterByQuery } from "../../skills/catalog-search.js";
import { clawhubSearch } from "../../skills/clawhub.js";
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
    .description("List all skills (bundled, installed, and catalog)")
    .option("--json", "Machine-readable JSON output")
    .addHelpText(
      "after",
      `
Lists all skills: bundled (compiled-in), installed (user-added), and
available catalog skills with their ID, name, and description.

Examples:
  $ assistant skills list
  $ assistant skills list --json`,
    )
    .action(async (opts: { json?: boolean }) => {
      try {
        // ── Bundled + installed skills (from loadSkillCatalog) ────────
        const localCatalog = loadSkillCatalog();
        const config = getConfig();
        const resolved = resolveSkillStates(localCatalog, config);
        const bundled = resolved.filter((r) => r.summary.source === "bundled");
        const installed = resolved.filter(
          (r) =>
            r.summary.source === "managed" ||
            r.summary.source === "workspace" ||
            r.summary.source === "extra",
        );

        // ── Remote catalog skills ────────────────────────────────────
        const repoSkillsDir = getRepoSkillsDir();
        let remoteCatalog: CatalogSkill[];
        if (repoSkillsDir) {
          remoteCatalog = readLocalCatalog(repoSkillsDir);
        } else {
          remoteCatalog = await fetchCatalog();
        }
        // Exclude catalog skills that are already installed/bundled
        const localIds = new Set(localCatalog.map((s) => s.id));
        const availableCatalog = remoteCatalog.filter(
          (s) => !localIds.has(s.id),
        );

        const totalCount =
          bundled.length + installed.length + availableCatalog.length;

        if (opts.json) {
          const bundledJson = bundled.map((r) => ({
            id: r.summary.id,
            name: r.summary.displayName,
            description: r.summary.description,
            emoji: r.summary.emoji,
            state: r.state,
          }));
          const installedJson = installed.map((r) => ({
            id: r.summary.id,
            name: r.summary.displayName,
            description: r.summary.description,
            emoji: r.summary.emoji,
            state: r.state,
          }));
          console.log(
            JSON.stringify({
              ok: true,
              skills: [...bundledJson, ...installedJson, ...availableCatalog],
              bundled: bundledJson,
              installed: installedJson,
              catalog: availableCatalog,
            }),
          );
          return;
        }

        if (totalCount === 0) {
          log.info("No skills available.");
          return;
        }

        if (bundled.length > 0) {
          log.info(`Bundled skills (${bundled.length}):\n`);
          for (const r of bundled) {
            const s = r.summary;
            const emoji = s.emoji ? `${s.emoji} ` : "";
            const state = r.state === "disabled" ? " [disabled]" : "";
            log.info(`  ${emoji}${s.id}${state}`);
            log.info(`    ${s.displayName} — ${s.description}`);
          }
          log.info("");
        }

        if (installed.length > 0) {
          log.info(`Installed skills (${installed.length}):\n`);
          for (const r of installed) {
            const s = r.summary;
            const emoji = s.emoji ? `${s.emoji} ` : "";
            const state = r.state === "disabled" ? " [disabled]" : "";
            log.info(`  ${emoji}${s.id}${state}`);
            log.info(`    ${s.displayName} — ${s.description}`);
          }
          log.info("");
        }

        if (availableCatalog.length > 0) {
          log.info(`Available catalog skills (${availableCatalog.length}):\n`);
          for (const s of availableCatalog) {
            const emoji = s.emoji ? `${s.emoji} ` : "";
            const deps = s.includes?.length
              ? ` (requires: ${s.includes.join(", ")})`
              : "";
            log.info(`  ${emoji}${s.id}`);
            log.info(`    ${s.name} — ${s.description}${deps}`);
          }
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
    .description(
      "Search the Vellum catalog, skills.sh, and clawhub community registries",
    )
    .option("--limit <n>", "Maximum number of community results", "10")
    .option("--json", "Machine-readable JSON output")
    .addHelpText(
      "after",
      `
Arguments:
  query    Free-text search term matched against skill names, descriptions,
           and tags. Searches the Vellum catalog, the skills.sh community
           registry, and the clawhub registry.

Displays results from all sources with clear labels. When a skill ID
exists in both the Vellum catalog and a community registry, a conflict
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
        // ── Bundled + installed skill search ─────────────────────────
        const localCatalog = loadSkillCatalog();
        const bundledMatches = filterByQuery(localCatalog, query, [
          (s) => s.id,
          (s) => s.displayName,
          (s) => s.description,
        ]);

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
        // Exclude catalog entries that match a bundled/installed skill
        const localIds = new Set(localCatalog.map((s) => s.id));
        const filteredCatalog = catalog.filter((s) => !localIds.has(s.id));

        const catalogMatches = filterByQuery(filteredCatalog, query, [
          (s) => s.id,
          (s) => s.name,
          (s) => s.description,
        ]);

        // ── Community registry searches (non-fatal on failure) ────────
        // Run skills.sh and clawhub searches in parallel.
        let registryResults: SkillsShSearchResult[] = [];
        let registryError: string | undefined;
        let clawhubResults: Awaited<
          ReturnType<typeof clawhubSearch>
        >["skills"] = [];
        let clawhubError: string | undefined;

        const [skillsShResult, clawhubResult] = await Promise.allSettled([
          searchSkillsRegistry(query, limit),
          clawhubSearch(query, { limit }),
        ]);

        if (skillsShResult.status === "fulfilled") {
          registryResults = skillsShResult.value;
        } else {
          registryError =
            skillsShResult.reason instanceof Error
              ? skillsShResult.reason.message
              : String(skillsShResult.reason);
        }

        if (clawhubResult.status === "fulfilled") {
          clawhubResults = clawhubResult.value.skills;
        } else {
          clawhubError =
            clawhubResult.reason instanceof Error
              ? clawhubResult.reason.message
              : String(clawhubResult.reason);
        }

        // ── Conflict detection ───────────────────────────────────────
        const catalogIds = new Set(catalogMatches.map((s) => s.id));
        const conflictIds = new Set([
          ...registryResults
            .filter((r) => catalogIds.has(r.skillId))
            .map((r) => r.skillId),
          ...clawhubResults
            .filter((r) => catalogIds.has(r.slug))
            .map((r) => r.slug),
        ]);

        if (
          bundledMatches.length === 0 &&
          catalogMatches.length === 0 &&
          registryResults.length === 0 &&
          clawhubResults.length === 0
        ) {
          if (json) {
            console.log(
              JSON.stringify({
                ok: true,
                bundled: [],
                catalog: [],
                community: [],
                clawhub: [],
                audits: {},
                ...(registryError ? { registryError } : {}),
                ...(clawhubError ? { clawhubError } : {}),
              }),
            );
          } else {
            log.info(`No skills found for "${query}".`);
            if (registryError) {
              log.warn(`(skills.sh registry unavailable: ${registryError})`);
            }
            if (clawhubError) {
              log.warn(`(clawhub registry unavailable: ${clawhubError})`);
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
              bundled: bundledMatches.map((s) => ({
                id: s.id,
                name: s.displayName,
                description: s.description,
                emoji: s.emoji,
                source: s.source,
              })),
              catalog: catalogMatches,
              community: registryResults,
              clawhub: clawhubResults,
              audits: allAudits,
              ...(registryError ? { registryError } : {}),
              ...(clawhubError ? { clawhubError } : {}),
            }),
          );
          return;
        }

        // ── Installed-state detection ─────────────────────────────────
        const skillsDir = getWorkspaceSkillsDir();
        const isInstalled = (id: string) =>
          existsSync(join(skillsDir, id, "SKILL.md"));

        // ── Display bundled/installed results ─────────────────────────
        if (bundledMatches.length > 0) {
          log.info(`Bundled & installed skills (${bundledMatches.length}):\n`);
          for (const s of bundledMatches) {
            const emoji = s.emoji ? `${s.emoji} ` : "";
            const tag = s.source === "bundled" ? " [bundled]" : " [installed]";
            log.info(`  ${emoji}${s.displayName}${tag}`);
            if (s.displayName !== s.id) {
              log.info(`    ID: ${s.id}`);
            }
            log.info(`    ${s.description}`);
            log.info(`    Load: skill_load skill=${s.id}`);
            log.info("");
          }
        }

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

        // ── Display clawhub results ─────────────────────────────────
        if (clawhubResults.length > 0) {
          log.info(`Clawhub registry (${clawhubResults.length}):\n`);
          for (const r of clawhubResults) {
            const installed = isInstalled(r.slug);
            const badge = installed ? " [installed]" : "";
            log.info(`  ${r.name}${badge}`);
            if (r.name !== r.slug) {
              log.info(`    ID: ${r.slug}`);
            }
            if (r.author) {
              log.info(`    Author: ${r.author}`);
            }
            if (r.description) {
              log.info(`    Description: ${r.description}`);
            }
            if (r.stars > 0) {
              log.info(`    Stars: ${r.stars}`);
            }
            if (r.installs > 0) {
              log.info(`    Installs: ${r.installs}`);
            }
            log.info(`    Install: npx clawhub install ${r.slug}`);
            if (conflictIds.has(r.slug)) {
              log.info(`    NOTE: Conflicts with Vellum catalog skill`);
            }
            log.info("");
          }
        } else if (clawhubError) {
          log.warn(`\n(clawhub registry unavailable: ${clawhubError})`);
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
    .addHelpText(
      "after",
      `
Arguments:
  skill-id   Skill identifier from the Vellum catalog. Run 'assistant skills list'
             to see available IDs. For community skills, use 'assistant skills add'.

Downloads and installs the skill into the workspace skills directory. If the
skill is already installed, use --overwrite to replace it.

Examples:
  $ assistant skills install weather
  $ assistant skills install weather --overwrite
  $ assistant skills install weather --json`,
    )
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
    .addHelpText(
      "after",
      `
Arguments:
  skill-id   Skill identifier to remove. Run 'assistant skills list' to see
             installed skills.

Removes the skill directory from the workspace. This action cannot be undone.

Examples:
  $ assistant skills uninstall weather
  $ assistant skills uninstall weather --json`,
    )
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
  repository and installs them into the workspace skills directory. An
  install-meta.json file is written with origin metadata for provenance tracking.

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
