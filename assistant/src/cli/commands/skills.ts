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
import { readInstallMeta } from "../../skills/install-meta.js";
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
// Helpers
// ---------------------------------------------------------------------------

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    const date = d.toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
    const time = d.toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });
    return `${date} ${time}`;
  } catch {
    return iso;
  }
}

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
  $ assistant skills inspect slack
  $ assistant skills inspect resend-setup --json
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
    .description("List bundled and installed skills")
    .option("--json", "Machine-readable JSON output")
    .addHelpText(
      "after",
      `
Lists all bundled and installed skills with their source, state, and
description. Use 'assistant skills inspect <id>' for detailed metadata
or 'assistant skills search' to discover catalog skills.

Examples:
  $ assistant skills list
  $ assistant skills list --json`,
    )
    .action(async (opts: { json?: boolean }) => {
      try {
        const localCatalog = loadSkillCatalog();
        const config = getConfig();
        const resolved = resolveSkillStates(localCatalog, config);

        // Flat alphabetical list — source is a property, not a section
        const allSkills = resolved
          .map((r) => {
            const s = r.summary;
            const source =
              s.source === "bundled" || s.source === "plugin"
                ? "bundled"
                : s.source; // managed, workspace, extra
            return {
              id: s.id,
              name: s.displayName,
              description: s.description,
              emoji: s.emoji,
              source,
              state: r.state,
            };
          })
          .sort((a, b) => a.id.localeCompare(b.id));

        if (opts.json) {
          console.log(JSON.stringify({ ok: true, skills: allSkills }));
          return;
        }

        if (allSkills.length === 0) {
          log.info("No skills available.");
          return;
        }

        log.info(`Skills (${allSkills.length}):\n`);
        for (const s of allSkills) {
          const emoji = s.emoji ? `${s.emoji} ` : "";
          const tags = [
            s.source,
            ...(s.state === "disabled" ? ["disabled"] : []),
          ];
          log.info(`  ${emoji}${s.id} [${tags.join(", ")}]`);
          log.info(`    ${s.name} — ${s.description}`);
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
    .command("inspect <skill-id>")
    .description("Show detailed information about a skill")
    .option("--json", "Machine-readable JSON output")
    .addHelpText(
      "after",
      `
Arguments:
  skill-id   Skill identifier. Run 'assistant skills list' to see available IDs.

Displays detailed metadata about a skill including its source, state,
description, install metadata (origin, version, content hash), config
entries, tool manifest, activation hints, and feature flags.

Examples:
  $ assistant skills inspect slack
  $ assistant skills inspect resend-setup --json`,
    )
    .action(async (skillId: string, opts: { json?: boolean }) => {
      try {
        const localCatalog = loadSkillCatalog();
        const config = getConfig();
        const resolved = resolveSkillStates(localCatalog, config);

        const match = resolved.find((r) => r.summary.id === skillId);
        if (!match) {
          throw new Error(
            `Skill "${skillId}" not found. Run 'assistant skills list' to see available skills.`,
          );
        }

        const { summary, state, configEntry } = match;
        const installMeta = readInstallMeta(summary.directoryPath);

        const detail: Record<string, unknown> = {
          id: summary.id,
          name: summary.displayName,
          description: summary.description,
          emoji: summary.emoji ?? null,
          source: summary.source,
          state,
          directoryPath: summary.directoryPath,
          featureFlag: summary.featureFlag ?? null,
          activationHints: summary.activationHints ?? null,
          avoidWhen: summary.avoidWhen ?? null,
          includes: summary.includes ?? null,
          toolManifest: summary.toolManifest
            ? {
                valid: summary.toolManifest.valid,
                toolCount: summary.toolManifest.toolCount,
                toolNames: summary.toolManifest.toolNames,
              }
            : null,
          installMeta: installMeta ?? null,
          config: configEntry
            ? {
                enabled: configEntry.enabled !== false,
                envKeys: configEntry.env
                  ? Object.keys(configEntry.env)
                  : [],
                configKeys: configEntry.config
                  ? Object.keys(configEntry.config)
                  : [],
              }
            : null,
        };

        if (opts.json) {
          console.log(JSON.stringify({ ok: true, skill: detail }));
          return;
        }

        const emoji = summary.emoji ? `${summary.emoji} ` : "";
        log.info(`${emoji}${summary.displayName} (${summary.id})`);
        log.info(`  ${summary.description}\n`);
        log.info(`  Source:    ${summary.source}`);
        log.info(`  State:     ${state}`);
        log.info(`  Path:      ${summary.directoryPath}`);
        if (summary.featureFlag) {
          log.info(`  Flag:      ${summary.featureFlag}`);
        }
        if (summary.includes?.length) {
          log.info(`  Includes:  ${summary.includes.join(", ")}`);
        }
        if (summary.activationHints?.length) {
          log.info(`  Hints:     ${summary.activationHints.join("; ")}`);
        }
        if (summary.avoidWhen?.length) {
          log.info(`  Avoid:     ${summary.avoidWhen.join("; ")}`);
        }

        if (summary.toolManifest) {
          const tm = summary.toolManifest;
          log.info(
            `\n  Tools:     ${tm.valid ? `${tm.toolCount} tool(s)` : "invalid manifest"}`,
          );
          if (tm.toolNames.length > 0) {
            for (const name of tm.toolNames) {
              log.info(`    - ${name}`);
            }
          }
        }

        if (installMeta) {
          log.info(`\n  Install metadata:`);
          log.info(`    Origin:      ${installMeta.origin}`);
          log.info(`    Installed:   ${installMeta.installedAt}`);
          if (installMeta.installedBy) {
            log.info(`    Installed by: ${installMeta.installedBy}`);
          }
          if (installMeta.version) {
            log.info(`    Version:     ${installMeta.version}`);
          }
          if (installMeta.slug) {
            log.info(`    Slug:        ${installMeta.slug}`);
          }
          if (installMeta.sourceRepo) {
            log.info(`    Source repo:  ${installMeta.sourceRepo}`);
          }
          if (installMeta.contentHash) {
            log.info(`    Hash:        ${installMeta.contentHash}`);
          }
          if (installMeta.backfilledBy) {
            log.info(`    Backfilled:  ${installMeta.backfilledBy}`);
          }
        }

        if (configEntry) {
          log.info(`\n  Config:`);
          log.info(
            `    Enabled:     ${configEntry.enabled !== false ? "yes" : "no"}`,
          );
          if (configEntry.env && Object.keys(configEntry.env).length > 0) {
            log.info(`    Env vars:    ${Object.keys(configEntry.env).join(", ")}`);
          }
          if (
            configEntry.config &&
            Object.keys(configEntry.config).length > 0
          ) {
            log.info(
              `    Config keys: ${Object.keys(configEntry.config).join(", ")}`,
            );
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
        const localIds = new Set(localCatalog.map((s) => s.id));

        const catalogMatches = filterByQuery(catalog, query, [
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
        const getInstalledDate = (id: string): string | undefined => {
          const meta = readInstallMeta(join(skillsDir, id));
          return meta?.installedAt;
        };

        // ── Display installed results ─────────────────────────────────
        if (bundledMatches.length > 0) {
          log.info(`Installed skills (${bundledMatches.length}):\n`);
          for (const s of bundledMatches) {
            const emoji = s.emoji ? `${s.emoji} ` : "";
            const tag =
              s.source === "bundled" || s.source === "plugin"
                ? " [bundled]"
                : "";
            log.info(`  ${emoji}${s.displayName}${tag}`);
            if (s.displayName !== s.id) {
              log.info(`    ID: ${s.id}`);
            }
            log.info(`    ${s.description}`);
            if (s.source !== "bundled" && s.source !== "plugin") {
              const meta = readInstallMeta(s.directoryPath);
              if (meta?.installedAt) {
                log.info(`    Installed: ${formatDate(meta.installedAt)}`);
              }
            }
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
            log.info(`    ${s.description}`);
            if (s.updatedAt) {
              log.info(`    Updated: ${formatDate(s.updatedAt)}`);
            }
            if (installed) {
              const installedDate = getInstalledDate(s.id);
              if (installedDate) {
                log.info(`    Installed: ${formatDate(installedDate)}`);
              }
            } else {
              log.info(`    Install: assistant skills install ${s.id}`);
            }

            log.info("");
          }
        }

        // ── Display community results ────────────────────────────────
        if (registryResults.length > 0) {
          log.info(`Community — skills.sh (${registryResults.length}):\n`);
          for (const r of registryResults) {
            const installed = isInstalled(r.skillId);
            const installedFromVellum = localIds.has(r.skillId);
            const badge = installedFromVellum
              ? " [installed from catalog]"
              : installed
                ? " [installed]"
                : "";
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
            if (!installed) {
              log.info(
                `    Install: assistant skills add ${r.source}@${r.skillId}`,
              );
            }

            log.info("");
          }
        } else if (registryError) {
          log.warn(`\n(skills.sh registry unavailable: ${registryError})`);
        }

        // ── Display clawhub results ─────────────────────────────────
        if (clawhubResults.length > 0) {
          log.info(`Community — Clawhub (${clawhubResults.length}):\n`);
          for (const r of clawhubResults) {
            const installed = isInstalled(r.slug);
            const installedFromVellum = localIds.has(r.slug);
            const badge = installedFromVellum
              ? " [installed from catalog]"
              : installed
                ? " [installed]"
                : "";
            log.info(`  ${r.name}${badge}`);
            if (r.name !== r.slug) {
              log.info(`    ID: ${r.slug}`);
            }
            if (r.author) {
              log.info(`    Author: ${r.author}`);
            }
            if (r.description) {
              log.info(`    ${r.description}`);
            }
            if (r.createdAt > 0) {
              log.info(
                `    Updated: ${formatDate(new Date(r.createdAt).toISOString())}`,
              );
            }
            if (r.stars > 0) {
              log.info(`    Stars: ${r.stars}`);
            }
            if (r.installs > 0) {
              log.info(`    Installs: ${r.installs}`);
            }
            if (!installed) {
              log.info(`    Install: npx clawhub install ${r.slug}`);
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
