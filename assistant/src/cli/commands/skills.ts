import type { Command } from "commander";

import { cliIpcCall, exitFromIpcResult } from "../../ipc/cli-client.js";
import { registerCommand } from "../lib/register-command.js";
import { log } from "../logger.js";

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

export function registerSkillsCommand(program: Command): void {
  registerCommand(program, {
    name: "skills",
    transport: "ipc",
    description: "Browse and install skills from the Vellum catalog",
    build: (skills) => {
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
        .action(async (opts: { json?: boolean }, _cmd) => {
          const r = await cliIpcCall<{
            skills: Array<{
              id: string;
              name: string;
              description: string;
              emoji?: string;
              origin: string;
              kind: string;
              status: string;
            }>;
          }>("listSkills", { queryParams: {} });
          if (!r.ok)
            return exitFromIpcResult({
              ok: false,
              error: r.error,
              statusCode: r.statusCode,
            });
          const allSkills = r
            .result!.skills.map((s) => ({
              id: s.id,
              name: s.name,
              description: s.description,
              emoji: s.emoji,
              source:
                s.origin === "vellum" && s.kind === "bundled"
                  ? "bundled"
                  : s.origin,
              state: s.status,
            }))
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
            const tags = [s.source, ...(s.state === "disabled" ? ["disabled"] : [])];
            log.info(`  ${emoji}${s.id} [${tags.join(", ")}]`);
            log.info(`    ${s.name} — ${s.description}`);
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
        .action(async (skillId: string, opts: { json?: boolean }, _cmd) => {
          const r = await cliIpcCall<{
            id: string;
            name: string;
            description: string;
            emoji: string | null;
            source: string;
            state: string;
            directoryPath: string;
            featureFlag: string | null;
            includes: string[] | null;
            activationHints: string[] | null;
            avoidWhen: string[] | null;
            toolManifest: {
              valid: boolean;
              toolCount: number;
              toolNames: string[];
            } | null;
            installMeta: Record<string, unknown> | null;
            config: {
              enabled: boolean;
              envKeys: string[];
              configKeys: string[];
            } | null;
          }>("skillsLocalInspect", { pathParams: { id: skillId } });
          if (!r.ok)
            return exitFromIpcResult({
              ok: false,
              error: r.error,
              statusCode: r.statusCode,
            });
          const detail = r.result!;
          if (opts.json) {
            console.log(JSON.stringify({ ok: true, skill: detail }));
            return;
          }
          const emoji = detail.emoji ? `${detail.emoji} ` : "";
          log.info(`${emoji}${detail.name} (${detail.id})`);
          log.info(`  ${detail.description}\n`);
          log.info(`  Source:    ${detail.source}`);
          log.info(`  State:     ${detail.state}`);
          log.info(`  Path:      ${detail.directoryPath}`);
          if (detail.featureFlag) log.info(`  Flag:      ${detail.featureFlag}`);
          if (detail.includes?.length)
            log.info(`  Includes:  ${detail.includes.join(", ")}`);
          if (detail.activationHints?.length)
            log.info(`  Hints:     ${detail.activationHints.join("; ")}`);
          if (detail.avoidWhen?.length)
            log.info(`  Avoid:     ${detail.avoidWhen.join("; ")}`);
          if (detail.toolManifest) {
            const tm = detail.toolManifest;
            log.info(
              `\n  Tools:     ${tm.valid ? `${tm.toolCount} tool(s)` : "invalid manifest"}`,
            );
            for (const name of tm.toolNames) log.info(`    - ${name}`);
          }
          if (detail.installMeta) {
            log.info(`\n  Install metadata:`);
            if (detail.installMeta.origin)
              log.info(`    Origin:      ${detail.installMeta.origin}`);
            if (detail.installMeta.installedAt)
              log.info(`    Installed:   ${detail.installMeta.installedAt}`);
            if (detail.installMeta.installedBy)
              log.info(`    Installed by: ${detail.installMeta.installedBy}`);
            if (detail.installMeta.version)
              log.info(`    Version:     ${detail.installMeta.version}`);
            if (detail.installMeta.slug)
              log.info(`    Slug:        ${detail.installMeta.slug}`);
            if (detail.installMeta.sourceRepo)
              log.info(`    Source repo:  ${detail.installMeta.sourceRepo}`);
            if (detail.installMeta.contentHash)
              log.info(`    Hash:        ${detail.installMeta.contentHash}`);
            if (detail.installMeta.backfilledBy)
              log.info(`    Backfilled:  ${detail.installMeta.backfilledBy}`);
          }
          if (detail.config) {
            log.info(`\n  Config:`);
            log.info(`    Enabled:     ${detail.config.enabled ? "yes" : "no"}`);
            if (detail.config.envKeys.length)
              log.info(`    Env vars:    ${detail.config.envKeys.join(", ")}`);
            if (detail.config.configKeys.length)
              log.info(
                `    Config keys: ${detail.config.configKeys.join(", ")}`,
              );
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

          // Step 1: Vellum catalog (installed + remote available)
          const catalogR = await cliIpcCall<{
            skills: Array<{
              id: string;
              name: string;
              description: string;
              emoji?: string;
              origin: string;
              kind: string;
              status: string;
              updatedAt?: string;
            }>;
          }>("listSkills", { queryParams: { include: "catalog", q: query } });
          const vellumSkills = catalogR.ok
            ? catalogR.result!.skills.filter((s) => s.origin === "vellum")
            : [];

          // Step 2: community (skills.sh with audits + clawhub) + local bundled/installed
          const communityR = await cliIpcCall<{
            skills: Array<{
              id: string;
              name: string;
              description: string;
              emoji?: string;
              origin: string;
              kind: string;
              status: string;
              slug?: string;
              author?: string;
              stars?: number;
              installs?: number;
              publishedAt?: string;
              version?: string;
              sourceRepo?: string;
            }>;
          }>("searchSkills", { queryParams: { q: query } });
          const communitySkills = communityR.ok
            ? communityR.result!.skills.filter((s) => s.origin !== "vellum")
            : [];

          // Deduplicate by id — vellum wins
          const seen = new Set(vellumSkills.map((s) => s.id));
          const dedupedCommunity = communitySkills.filter((s) => {
            if (seen.has(s.id)) return false;
            seen.add(s.id);
            return true;
          });
          const clawhubResults = dedupedCommunity
            .filter((s) => s.origin === "clawhub")
            .slice(0, limit);
          const skillsshResults = dedupedCommunity
            .filter((s) => s.origin === "skillssh")
            .slice(0, limit);

          const hasResults =
            vellumSkills.length > 0 ||
            clawhubResults.length > 0 ||
            skillsshResults.length > 0;

          if (json) {
            console.log(
              JSON.stringify({
                ok: true,
                catalog: vellumSkills,
                community: skillsshResults,
                clawhub: clawhubResults,
                ...(catalogR.ok ? {} : { catalogError: catalogR.error }),
                ...(communityR.ok ? {} : { communityError: communityR.error }),
              }),
            );
            return;
          }

          if (!hasResults) {
            log.info(`No skills found for "${query}".`);
            if (!catalogR.ok)
              log.warn(`(Vellum catalog unavailable: ${catalogR.error})`);
            if (!communityR.ok)
              log.warn(`(Community registry unavailable: ${communityR.error})`);
            return;
          }

          if (vellumSkills.length > 0) {
            log.info(`Vellum catalog (${vellumSkills.length}):\n`);
            for (const s of vellumSkills) {
              const emoji = s.emoji ? `${s.emoji} ` : "";
              const badge = s.kind === "installed" ? " [installed]" : "";
              log.info(`  ${emoji}${s.name}${badge}`);
              if (s.name !== s.id) log.info(`    ID: ${s.id}`);
              log.info(`    ${s.description}`);
              if (s.updatedAt) log.info(`    Updated: ${s.updatedAt}`);
              if (s.kind !== "installed")
                log.info(`    Install: assistant skills install ${s.id}`);
              log.info("");
            }
          }

          if (skillsshResults.length > 0) {
            log.info(`Community — skills.sh (${skillsshResults.length}):\n`);
            for (const r of skillsshResults) {
              const badge = r.kind === "installed" ? " [installed]" : "";
              log.info(`  ${r.name}${badge}`);
              if (r.name !== r.id) log.info(`    ID: ${r.id}`);
              if (r.sourceRepo) log.info(`    Source: ${r.sourceRepo}`);
              if (r.installs !== undefined)
                log.info(`    Installs: ${r.installs}`);
              if (r.kind !== "installed")
                log.info(
                  `    Install: assistant skills add ${r.sourceRepo ?? r.id}@${r.slug ?? r.id}`,
                );
              log.info("");
            }
          } else if (!communityR.ok) {
            log.warn(
              `\n(skills.sh registry unavailable: ${communityR.error})`,
            );
          }

          if (clawhubResults.length > 0) {
            log.info(`Community — Clawhub (${clawhubResults.length}):\n`);
            for (const r of clawhubResults) {
              const badge = r.kind === "installed" ? " [installed]" : "";
              log.info(`  ${r.name}${badge}`);
              if (r.name !== r.id) log.info(`    ID: ${r.id}`);
              if (r.author) log.info(`    Author: ${r.author}`);
              if (r.description) log.info(`    ${r.description}`);
              if (r.stars) log.info(`    Stars: ${r.stars}`);
              if (r.installs) log.info(`    Installs: ${r.installs}`);
              if (r.kind !== "installed")
                log.info(`    Install: npx clawhub install ${r.slug ?? r.id}`);
              log.info("");
            }
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
            _cmd,
          ) => {
            const json = opts.json ?? false;

            // Step 1: catalog resolve — verify skill exists before attempting install
            const catalogR = await cliIpcCall<{
              skills: Array<{ id: string; name: string; origin: string }>;
            }>("listSkills", {
              queryParams: { include: "catalog", q: skillId },
            });
            if (!catalogR.ok)
              return exitFromIpcResult({
                ok: false,
                error: catalogR.error,
                statusCode: catalogR.statusCode,
              });
            const entry = catalogR.result!.skills.find(
              (s) => s.id === skillId && s.origin === "vellum",
            );
            if (!entry) {
              if (json) {
                console.log(
                  JSON.stringify({
                    ok: false,
                    error: `Skill "${skillId}" not found in the Vellum catalog`,
                  }),
                );
              } else {
                log.error(
                  `Skill "${skillId}" not found in the Vellum catalog. Run 'assistant skills search ${skillId}' to check available skills.`,
                );
              }
              process.exitCode = 2;
              return;
            }

            // Step 2: install
            const installR = await cliIpcCall<{ ok: boolean; skillId?: string }>(
              "installSkill",
              { body: { slug: skillId, overwrite: opts.overwrite ?? false } },
            );
            if (!installR.ok)
              return exitFromIpcResult({
                ok: false,
                error: installR.error,
                statusCode: installR.statusCode,
              });

            if (json) {
              console.log(JSON.stringify({ ok: true, skillId }));
            } else {
              log.info(`Installed skill "${skillId}".`);
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
        .action(async (skillId: string, opts: { json?: boolean }, _cmd) => {
          const r = await cliIpcCall<null>("deleteSkill", {
            pathParams: { id: skillId },
          });
          if (!r.ok)
            return exitFromIpcResult({
              ok: false,
              error: r.error,
              statusCode: r.statusCode,
            });
          if (opts.json) {
            console.log(JSON.stringify({ ok: true, skillId }));
          } else {
            log.info(`Uninstalled skill "${skillId}".`);
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
          async (
            source: string,
            opts: { overwrite?: boolean; json?: boolean },
            _cmd,
          ) => {
            const json = opts.json ?? false;

            const r = await cliIpcCall<{ ok: boolean; skillId?: string }>(
              "installSkill",
              { body: { slug: source, overwrite: opts.overwrite ?? false } },
            );
            if (!r.ok)
              return exitFromIpcResult({
                ok: false,
                error: r.error,
                statusCode: r.statusCode,
              });

            if (json) {
              console.log(
                JSON.stringify({
                  ok: true,
                  skillId: r.result?.skillId ?? source,
                }),
              );
            } else {
              log.info(`Installed skill from ${source}.`);
            }
          },
        );
    },
  });
}
