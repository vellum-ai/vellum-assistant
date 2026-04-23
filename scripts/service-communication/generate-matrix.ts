#!/usr/bin/env bun
/**
 * Renders docs/service-communication-matrix.md from the typed matrix source.
 *
 * Usage:
 *   bun run scripts/service-communication/generate-matrix.ts
 *
 * The output is deterministic — re-running produces the same file contents
 * given the same matrix-source.ts input, so diffs are additive and reviewable.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { MATRIX_ENTRIES, type MatrixEntry } from "./matrix-source.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const group = map.get(k);
    if (group) {
      group.push(item);
    } else {
      map.set(k, [item]);
    }
  }
  return map;
}

function directionKey(entry: MatrixEntry): string {
  return `${entry.caller} -> ${entry.callee}`;
}

export function serviceDisplayName(name: string): string {
  switch (name) {
    case "assistant":
      return "Assistant";
    case "gateway":
      return "Gateway";
    case "ces":
      return "CES";
    default:
      return name;
  }
}

// ---------------------------------------------------------------------------
// Markdown rendering
// ---------------------------------------------------------------------------

export function renderMatrix(entries: MatrixEntry[]): string {
  const lines: string[] = [];

  lines.push("# Service Communication Matrix");
  lines.push("");
  lines.push(
    "> **Auto-generated** from `scripts/service-communication/matrix-source.ts`.",
  );
  lines.push("> Do not edit by hand. Run `bun run scripts/service-communication/generate-matrix.ts` to regenerate.");
  lines.push("");
  lines.push(
    "This document enumerates every observed communication permutation between the three core services:",
  );
  lines.push(
    "**Assistant** (daemon), **Gateway** (channel ingress), and **CES** (Credential Execution Service).",
  );
  lines.push("");

  // Summary table
  lines.push("## Summary");
  lines.push("");
  lines.push(
    "| # | Direction | Protocol | Auth | Label |",
  );
  lines.push(
    "|---|-----------|----------|------|-------|",
  );

  entries.forEach((e, i) => {
    lines.push(
      `| ${i + 1} | ${serviceDisplayName(e.caller)} -> ${serviceDisplayName(e.callee)} | \`${e.protocol}\` | ${e.auth} | ${e.label} |`,
    );
  });

  lines.push("");

  // Grouped detail sections
  const grouped = groupBy(entries, directionKey);

  for (const [direction, group] of grouped) {
    const [callerName, calleeName] = direction.split(" -> ");
    lines.push(
      `## ${serviceDisplayName(callerName)} -> ${serviceDisplayName(calleeName)}`,
    );
    lines.push("");

    for (const entry of group) {
      lines.push(`### ${entry.label}`);
      lines.push("");
      lines.push(`- **Protocol:** \`${entry.protocol}\``);
      lines.push(`- **Auth:** ${entry.auth}`);
      lines.push(`- **Description:** ${entry.description}`);
      lines.push("");
      lines.push("**Caller files:**");
      for (const glob of entry.callerGlobs) {
        lines.push(`- \`${glob}\``);
      }
      lines.push("");
      lines.push("**Callee files:**");
      for (const glob of entry.calleeGlobs) {
        lines.push(`- \`${glob}\``);
      }
      lines.push("");
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  const repoRoot = join(import.meta.dir, "..", "..");
  const outputPath = join(repoRoot, "docs", "service-communication-matrix.md");

  const content = renderMatrix(MATRIX_ENTRIES);
  writeFileSync(outputPath, content, "utf-8");

  // eslint-disable-next-line no-console
  console.log(`Wrote ${outputPath}`);
}

main();
