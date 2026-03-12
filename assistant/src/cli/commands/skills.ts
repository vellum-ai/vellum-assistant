import type { Command } from "commander";

import type { CatalogSkill } from "../../skills/catalog-install.js";
import {
  fetchCatalog,
  getRepoSkillsDir,
  installSkillLocally,
  readLocalCatalog,
  uninstallSkillLocally,
} from "../../skills/catalog-install.js";
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
  $ assistant skills install weather
  $ assistant skills install weather --overwrite
  $ assistant skills uninstall weather`,
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
}
