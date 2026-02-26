#!/usr/bin/env bun
/**
 * CLI wrapper for skills.sh operations.
 *
 * Provides search, evaluate, and install subcommands that wrap the
 * underlying TypeScript modules so skills can teach the assistant
 * to drive them via CLI rather than requiring registered tools.
 */

import { Command } from 'commander';

import { makeSecurityDecision } from './security-decision.js';
import type { SecurityDecision } from './security-decision.js';
import {
  skillsshFetchAudit,
  skillsshSearchWithAudit,
} from './skillssh.js';
import type { SkillsShSearchWithAuditItem } from './skillssh.js';
import { skillsshInstall } from './skillssh-install.js';

// ─── Output helpers ──────────────────────────────────────────────────────────

function formatRiskBadge(risk: string): string {
  const badges: Record<string, string> = {
    safe: '[SAFE]',
    low: '[LOW]',
    medium: '[MEDIUM]',
    high: '[HIGH]',
    critical: '[CRITICAL]',
    unknown: '[UNKNOWN]',
  };
  return badges[risk] ?? `[${risk.toUpperCase()}]`;
}

function formatSearchResults(skills: SkillsShSearchWithAuditItem[], query: string): string {
  if (skills.length === 0) {
    return `No skills found for query: "${query}"`;
  }

  const lines: string[] = [`Found ${skills.length} skill(s) for "${query}":\n`];

  for (const skill of skills) {
    lines.push(`  ${skill.name} (${skill.source}/${skill.skillId})`);
    lines.push(`    Risk: ${formatRiskBadge(skill.overallRisk)}  Installs: ${skill.installs}`);

    const providers = ['ath', 'socket', 'snyk'] as const;
    const auditParts: string[] = [];
    for (const p of providers) {
      const dim = skill.audit[p];
      if (dim) {
        let detail = `${p}: ${dim.risk}`;
        if (dim.alerts != null) detail += ` (${dim.alerts} alert${dim.alerts === 1 ? '' : 's'})`;
        if (dim.score != null) detail += ` (score ${dim.score}/100)`;
        auditParts.push(detail);
      }
    }
    if (auditParts.length > 0) {
      lines.push(`    Audit: ${auditParts.join(', ')}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

function formatSecurityDecision(decision: SecurityDecision, source: string, skillId: string): string {
  const lines: string[] = [
    `Security evaluation for ${source}/${skillId}:\n`,
    `  Recommendation: ${decision.recommendation}`,
    `  Overall risk: ${formatRiskBadge(decision.overallRisk)}`,
    `  Rationale: ${decision.rationale}`,
  ];

  if (decision.auditSummary.length > 0) {
    lines.push('');
    lines.push('  Audit dimensions:');
    for (const dim of decision.auditSummary) {
      const label = dim.provider.charAt(0).toUpperCase() + dim.provider.slice(1);
      let detail = `    ${label}: ${dim.risk} (analyzed ${dim.analyzedAt})`;
      if (dim.details) detail += ` — ${dim.details}`;
      lines.push(detail);
    }
  }

  return lines.join('\n');
}

// ─── CLI definition ──────────────────────────────────────────────────────────

export function createCli(): Command {
  const program = new Command()
    .name('skillssh-cli')
    .description('Search, evaluate, and install skills from skills.sh')
    .version('1.0.0');

  program
    .command('search')
    .description('Search skills.sh and return results with audit risk levels')
    .argument('<query>', 'Search query')
    .option('-l, --limit <n>', 'Max results to return', '5')
    .option('--json', 'Output as JSON')
    .action(async (query: string, opts: { limit: string; json?: boolean }) => {
      try {
        const limit = parseInt(opts.limit, 10);
        const result = await skillsshSearchWithAudit(query, { limit });

        if (opts.json) {
          process.stdout.write(JSON.stringify(result, null, 2) + '\n');
        } else {
          process.stdout.write(formatSearchResults(result.skills, result.query) + '\n');
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`Error: ${message}\n`);
        process.exitCode = 1;
      }
    });

  program
    .command('evaluate')
    .description('Fetch audit and produce a security recommendation for a skill')
    .argument('<source>', 'GitHub repo path (e.g. owner/repo)')
    .argument('<skillId>', 'Skill identifier')
    .option('--json', 'Output as JSON')
    .action(async (source: string, skillId: string, opts: { json?: boolean }) => {
      try {
        const audit = await skillsshFetchAudit(source, skillId);
        const decision = makeSecurityDecision(audit);

        if (opts.json) {
          process.stdout.write(JSON.stringify(decision, null, 2) + '\n');
        } else {
          process.stdout.write(formatSecurityDecision(decision, source, skillId) + '\n');
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`Error: ${message}\n`);
        process.exitCode = 1;
      }
    });

  program
    .command('install')
    .description('Install a skill from skills.sh with security check')
    .argument('<source>', 'GitHub repo path (e.g. owner/repo)')
    .argument('<skillId>', 'Skill identifier')
    .option('--override', 'Override security restrictions for do_not_recommend skills')
    .option('--json', 'Output as JSON')
    .action(async (source: string, skillId: string, opts: { override?: boolean; json?: boolean }) => {
      try {
        // Fetch audit and make security decision
        const audit = await skillsshFetchAudit(source, skillId);
        const securityDecision = makeSecurityDecision(audit);

        // Build candidate from audit data
        const candidate: SkillsShSearchWithAuditItem = {
          id: `${source}/${skillId}`,
          skillId,
          name: skillId,
          installs: 0,
          source,
          audit,
          overallRisk: securityDecision.overallRisk,
        };

        const result = await skillsshInstall({
          candidate,
          securityDecision,
          userOverride: opts.override,
        });

        if (opts.json) {
          process.stdout.write(JSON.stringify(result, null, 2) + '\n');
          if (!result.success) process.exitCode = 1;
        } else {
          if (result.success) {
            process.stdout.write(
              `Successfully installed ${result.skillId} at ${result.installedPath}\n` +
              `Installed via: ${result.installedVia}\n`,
            );
          } else {
            process.stderr.write(`Installation failed: ${result.error}\n`);
            process.exitCode = 1;
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`Error: ${message}\n`);
        process.exitCode = 1;
      }
    });

  return program;
}

// ─── Entry point ─────────────────────────────────────────────────────────────

// Only run when executed directly (not when imported for testing)
const isDirectExecution = import.meta.url === Bun.main || process.argv[1]?.endsWith('skillssh-cli.ts');
if (isDirectExecution) {
  const program = createCli();
  program.parseAsync(process.argv).catch((err) => {
    process.stderr.write(`Fatal: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
}
