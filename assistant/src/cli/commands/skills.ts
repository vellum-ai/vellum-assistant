import type { Command } from "commander";

import { cliIpcCall, exitFromIpcResult } from "../../ipc/cli-client.js";
import { applyCommandHelp, subcommand } from "../lib/cli-command-help.js";
import { registerCommand } from "../lib/register-command.js";
import { log } from "../logger.js";
import { skillsHelp } from "./skills.help.js";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Map an IPC failure to a CLI exit code, mirroring `exitFromIpcResult`'s
 * status→exit table without calling `process.exit` (so callers can flush
 * stdout before the process tears down).
 */
function exitCodeFromStatus(statusCode: number | undefined): number {
  if (statusCode === undefined) return 10;
  if (statusCode >= 500) return 3;
  if (statusCode >= 400) return 2;
  return 1;
}

/**
 * Surface an IPC failure on a CLI command that supports `--json`. When `json`
 * is true, emit a `{ok:false,error}` document to stdout and set `exitCode`
 * without writing to stderr — so machine readers can parse output uniformly
 * across success and failure paths. When `json` is false, fall back to
 * `exitFromIpcResult` for the existing stderr-write + `process.exit`
 * behaviour, preserving the human-mode UX.
 */
function exitFromCliResult(
  r: { ok: false; error?: string; statusCode?: number },
  json: boolean,
): void {
  if (json) {
    console.log(
      JSON.stringify({ ok: false, error: r.error ?? "Unknown error" }),
    );
    process.exitCode = exitCodeFromStatus(r.statusCode);
    return;
  }
  exitFromIpcResult(r);
}

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

export function registerSkillsCommand(program: Command): void {
  registerCommand(program, {
    name: skillsHelp.name,
    transport: "ipc",
    description: skillsHelp.description,
    build: (skills) => {
      applyCommandHelp(skills, skillsHelp);

      subcommand(skills, "list").action(
        async (opts: { json?: boolean }, _cmd) => {
          const r = await cliIpcCall<{
            skills: Array<{
              id: string;
              name: string;
              description: string;
              emoji?: string;
              origin: string;
              kind: string;
              status: string;
              owner?: { kind: string; id: string };
            }>;
          }>("listSkills", { queryParams: {} });
          if (!r.ok)
            return exitFromCliResult(
              { ok: false, error: r.error, statusCode: r.statusCode },
              opts.json ?? false,
            );
          // Source labels the extension a skill ships from. Plugin-resident
          // skills are intentionally mapped to kind:bundled/origin:vellum for
          // older clients, so their real attribution lives on `owner` —
          // surface it as `plugin:<id>` instead of collapsing to "bundled".
          const sourceLabel = (s: {
            origin: string;
            kind: string;
            owner?: { kind: string; id: string };
          }): string => {
            if (s.owner) return `${s.owner.kind}:${s.owner.id}`;
            if (s.origin === "vellum" && s.kind === "bundled") return "bundled";
            return s.origin;
          };
          const allSkills = r
            .result!.skills.map((s) => ({
              id: s.id,
              name: s.name,
              description: s.description,
              emoji: s.emoji,
              source: sourceLabel(s),
              owner: s.owner,
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
          // Align ID / SOURCE / STATE into columns so source is scannable.
          const idWidth = Math.max(2, ...allSkills.map((s) => s.id.length));
          const srcWidth = Math.max(
            6,
            ...allSkills.map((s) => s.source.length),
          );
          log.info(`Skills (${allSkills.length}):\n`);
          log.info(
            `  ${"ID".padEnd(idWidth)}  ${"SOURCE".padEnd(srcWidth)}  STATE`,
          );
          for (const s of allSkills) {
            const emoji = s.emoji ? `${s.emoji} ` : "";
            log.info(
              `  ${s.id.padEnd(idWidth)}  ${s.source.padEnd(srcWidth)}  ${s.state}`,
            );
            log.info(`    ${emoji}${s.name} — ${s.description}`);
          }
        },
      );

      subcommand(skills, "inspect").action(
        async (skillId: string, opts: { json?: boolean }, _cmd) => {
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
            return exitFromCliResult(
              { ok: false, error: r.error, statusCode: r.statusCode },
              opts.json ?? false,
            );
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
          if (detail.featureFlag)
            log.info(`  Flag:      ${detail.featureFlag}`);
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
            log.info(
              `    Enabled:     ${detail.config.enabled ? "yes" : "no"}`,
            );
            if (detail.config.envKeys.length)
              log.info(`    Env vars:    ${detail.config.envKeys.join(", ")}`);
            if (detail.config.configKeys.length)
              log.info(
                `    Config keys: ${detail.config.configKeys.join(", ")}`,
              );
          }
        },
      );

      subcommand(skills, "search").action(
        async (query: string, opts: { limit: string; json?: boolean }) => {
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
          }>("searchSkills", {
            queryParams: { q: query, limit: String(limit) },
          });
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
                // Use the fully-qualified 3-segment id (owner/repo/skill) — this
                // matches the `owner/repo/skill-name` form accepted by
                // `resolveSkillSource()`. Building `sourceRepo@slug` fails for
                // skills.sh because the registry returns `slug` as the full id,
                // producing `owner/repo@owner/repo/skill` which the parser rejects.
                log.info(`    Install: assistant skills add ${r.id}`);
              log.info("");
            }
          } else if (!communityR.ok) {
            log.warn(`\n(skills.sh registry unavailable: ${communityR.error})`);
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
        },
      );

      subcommand(skills, "install").action(
        async (
          skillId: string,
          opts: { overwrite?: boolean; json?: boolean },
          _cmd,
        ) => {
          const json = opts.json ?? false;

          // Restrict to catalog-only; community installs use `skills add`.
          const installR = await cliIpcCall<{
            ok: boolean;
            skillId?: string;
          }>("installSkill", {
            body: {
              slug: skillId,
              overwrite: opts.overwrite ?? false,
              catalogOnly: true,
            },
          });
          if (!installR.ok) {
            if (json) {
              console.log(
                JSON.stringify({
                  ok: false,
                  error: installR.error,
                }),
              );
              process.exitCode = 1;
              return;
            }
            log.error(installR.error);
            log.error(
              `Run 'assistant skills search ${skillId}' to check available skills.`,
            );
            process.exitCode = 1;
            return;
          }

          if (json) {
            console.log(JSON.stringify({ ok: true, skillId }));
          } else {
            log.info(`Installed skill "${skillId}".`);
          }
        },
      );

      subcommand(skills, "uninstall").action(
        async (skillId: string, opts: { json?: boolean }, _cmd) => {
          const r = await cliIpcCall<null>("deleteSkill", {
            pathParams: { id: skillId },
          });
          if (!r.ok)
            return exitFromCliResult(
              { ok: false, error: r.error, statusCode: r.statusCode },
              opts.json ?? false,
            );
          if (opts.json) {
            console.log(JSON.stringify({ ok: true, skillId }));
          } else {
            log.info(`Uninstalled skill "${skillId}".`);
          }
        },
      );

      subcommand(skills, "add").action(
        async (
          source: string,
          opts: { overwrite?: boolean; json?: boolean },
          _cmd,
        ) => {
          const json = opts.json ?? false;

          // `add` is the community-install entry point (skills.sh-flavoured
          // sources: `owner/repo@skill`, `owner/repo/skill`, or full GitHub
          // URL). Pass `origin: "skillssh"` so the daemon routes via
          // `resolveSkillSource()` + `installExternalSkill()` regardless of
          // slug shape — the auto-detect (`looksLikeSkillsShSlug`) only
          // recognises 3-segment `/`-delimited slugs, so the `@`-format
          // documented in the help text otherwise misroutes to clawhub.
          const r = await cliIpcCall<{ ok: boolean; skillId?: string }>(
            "installSkill",
            {
              body: {
                slug: source,
                origin: "skillssh",
                overwrite: opts.overwrite ?? false,
              },
            },
          );
          if (!r.ok)
            return exitFromCliResult(
              { ok: false, error: r.error, statusCode: r.statusCode },
              json,
            );

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
