import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { WorkspaceMigration } from "./types.js";

export const repairMemoryV2SummaryFrontmatterMigration: WorkspaceMigration = {
  id: "088-repair-memory-v2-summary-frontmatter",
  description:
    "Quote malformed memory v2 frontmatter summary values and remove null summaries",

  run(workspaceDir: string): void {
    const conceptsDir = join(workspaceDir, "memory", "concepts");
    repairMarkdownFiles(conceptsDir);
  },

  down(_workspaceDir: string): void {
    // Forward-only data repair.
  },
};

function repairMarkdownFiles(rootDir: string): void {
  const stack = [rootDir];

  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const entryPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(entryPath);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        repairConceptPage(entryPath);
      }
    }
  }
}

function repairConceptPage(filePath: string): void {
  let stat;
  try {
    stat = statSync(filePath);
  } catch {
    return;
  }
  if (!stat.isFile()) return;

  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch {
    return;
  }

  const repaired = repairFrontmatterSummary(raw);
  if (repaired === null || repaired === raw) return;

  try {
    writeFileSync(filePath, repaired, "utf-8");
  } catch {
    // Best-effort repair. A single unreadable page must not block startup.
  }
}

function repairFrontmatterSummary(raw: string): string | null {
  const match = raw.match(/^(---\r?\n)([\s\S]*?)(\r?\n---)(\r?\n|$)([\s\S]*)$/);
  if (!match) return null;

  const [, openDelimiter, frontmatter, closeDelimiter, afterClose, body] =
    match;
  const newline = openDelimiter.endsWith("\r\n") ? "\r\n" : "\n";
  const lines = frontmatter.split(/\r?\n/);
  const repairedLines: string[] = [];
  let changed = false;

  for (const line of lines) {
    const summary = line.match(/^summary:(.*)$/);
    if (!summary) {
      repairedLines.push(line);
      continue;
    }

    const value = summary[1].trim();
    if (isNullSummaryValue(value)) {
      changed = true;
      continue;
    }

    if (!needsSummaryRepair(value)) {
      repairedLines.push(line);
      continue;
    }

    repairedLines.push(
      `summary: ${JSON.stringify(normalizeSummaryValue(value))}`,
    );
    changed = true;
  }

  if (!changed) return null;
  return `${openDelimiter}${repairedLines.join(
    newline,
  )}${closeDelimiter}${afterClose}${body}`;
}

function isNullSummaryValue(value: string): boolean {
  return value === "" || value === "~" || value.toLowerCase() === "null";
}

function needsSummaryRepair(value: string): boolean {
  if (/^[|>][-+]?$/.test(value)) return false;
  if (isSafeQuotedYamlString(value)) return false;
  if (startsOrEndsWithQuote(value)) return true;
  return /:\s/.test(value);
}

function normalizeSummaryValue(value: string): string {
  if (hasUnsafeOuterQuotes(value)) {
    return value.slice(1, -1);
  }
  return value;
}

function startsOrEndsWithQuote(value: string): boolean {
  return (
    value.startsWith('"') ||
    value.endsWith('"') ||
    value.startsWith("'") ||
    value.endsWith("'")
  );
}

function isSafeQuotedYamlString(value: string): boolean {
  if (value.length < 2) return false;

  const first = value[0];
  if (first !== '"' && first !== "'") return false;
  if (value[value.length - 1] !== first) return false;

  const inner = value.slice(1, -1);
  return first === "'"
    ? hasOnlyEscapedSingleQuotes(inner)
    : hasOnlyEscapedDoubleQuotes(inner);
}

function hasUnsafeOuterQuotes(value: string): boolean {
  return (
    value.length >= 2 &&
    value[0] === value[value.length - 1] &&
    (value[0] === '"' || value[0] === "'") &&
    !isSafeQuotedYamlString(value)
  );
}

function hasOnlyEscapedSingleQuotes(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    if (value[i] !== "'") continue;
    if (value[i + 1] !== "'") return false;
    i += 1;
  }
  return true;
}

function hasOnlyEscapedDoubleQuotes(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    if (value[i] !== '"') continue;

    let backslashes = 0;
    for (let j = i - 1; j >= 0 && value[j] === "\\"; j -= 1) {
      backslashes += 1;
    }
    if (backslashes % 2 === 0) return false;
  }
  return true;
}
