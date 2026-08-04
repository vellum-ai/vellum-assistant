/**
 * Parser for plugin-declared schedules under `<pluginDir>/schedules/`.
 *
 * Two declaration forms are supported:
 * - Flat file: `<name>.md` with YAML frontmatter (the schedule config) and a
 *   markdown body (the prompt message). Mode is `execute`.
 * - Directory: `<name>/` containing `config.json` (the schedule config) plus
 *   exactly one entrypoint, `index.md` (mode `execute`, body is the prompt)
 *   or `index.sh` (mode `script`, invoked by absolute path via its shebang
 *   interpreter, or `sh` when it has none).
 *
 * Ambiguity fails closed, never resolves by precedence: a basename declared
 * in both forms, a directory with zero or multiple entrypoints, or an
 * unsupported entrypoint each yield a {@link DeclarationError} and the
 * schedule does not load. Errors are per-schedule; one bad declaration never
 * blocks siblings.
 *
 * Declared schedules are recurring only: `expression` is required, a
 * single-fire RRULE (COUNT=1) is rejected, and there is no one-shot form.
 *
 * Pure filesystem + parsing. This module must not import from persistence or
 * schedule-store; the reconciler owns all database interaction.
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import { isPluginDisabled } from "../plugins/disabled-state.js";
import { walkPluginTree } from "../plugins/plugin-tree-walk.js";
import {
  FRONTMATTER_REGEX,
  parseFrontmatterFields,
} from "../skills/frontmatter.js";
import { getWorkspacePluginsDir } from "../util/platform.js";
import {
  computeNextRunAt,
  isSingleFireRRule,
  isValidScheduleExpression,
  validateRruleSetLines,
} from "./recurrence-engine.js";
import type { ScheduleSyntax } from "./recurrence-types.js";
import { normalizeScheduleSyntax } from "./recurrence-types.js";
import { validateScriptTimeoutMs } from "./run-script.js";

export type PluginScheduleMode = "execute" | "script";

/** Normalized schedule config parsed from frontmatter or config.json. */
export interface PluginScheduleConfig {
  expression: string;
  syntax: ScheduleSyntax;
  timezone: string | null;
  description: string | null;
  maxRetries: number | null;
  retryBackoffMs: number | null;
  quiet: boolean | null;
  inferenceProfile: string | null;
  timeoutMs: number | null;
  /** Declared enabled state; defaults to true when omitted. */
  enabled: boolean;
}

export interface ScheduleDeclaration {
  /** `plugin:<pluginName>/<scheduleName>`; the reconciler's identity key. */
  sourceKey: string;
  name: string;
  mode: PluginScheduleMode;
  /** Prompt body for `execute` mode; null for `script` mode. */
  message: string | null;
  /**
   * Shell invocation of the declaration's `index.sh`: its shebang
   * interpreter (or `sh` when it has none) followed by the quoted absolute
   * path, rather than the file's content. The explicit interpreter keeps
   * the entrypoint runnable when an install path drops its exec bit. Null
   * for `execute` mode.
   */
  scriptInvocation: string | null;
  config: PluginScheduleConfig;
  /**
   * Stable sha256 over the declaration's file contents and their paths
   * relative to `schedules/`. Any edit, addition, removal, or rename of a
   * declaration file changes the hash.
   */
  definitionHash: string;
}

export interface DeclarationError {
  pluginName: string;
  scheduleName: string;
  sourceKey: string;
  reason: string;
}

export interface ParsedPluginSchedules {
  declarations: ScheduleDeclaration[];
  errors: DeclarationError[];
}

function pluginScheduleSourceKey(
  pluginName: string,
  scheduleName: string,
): string {
  return `plugin:${pluginName}/${scheduleName}`;
}

/**
 * True when the declaration behind `sourceKey`
 * (`plugin:<pluginName>/<scheduleName>`) is present on disk in either
 * declaration form, a flat `<name>.md` or a `<name>/` directory, and the
 * plugin is not disabled. The `.disabled` sentinel counts as absent: a
 * disabled plugin's schedules must not be re-armable from a stale row even
 * though its files are still on disk. A cheap existence probe only; parsing
 * and validity are the reconciler's business.
 */
export function declarationExistsOnDisk(sourceKey: string): boolean {
  const match = /^plugin:([^/]+)\/(.+)$/.exec(sourceKey);
  if (!match) {
    return false;
  }
  const [, pluginName, scheduleName] = match;
  if (isPluginDisabled(pluginName!)) {
    return false;
  }
  const schedulesDir = join(getWorkspacePluginsDir(), pluginName!, "schedules");
  return (
    existsSync(join(schedulesDir, `${scheduleName!}.md`)) ||
    existsSync(join(schedulesDir, scheduleName!))
  );
}

const scheduleConfigSchema = z
  .object({
    expression: z.string().min(1),
    expression_syntax: z.enum(["cron", "rrule"]).optional(),
    timezone: z.string().min(1).optional(),
    description: z.string().optional(),
    max_retries: z.number().int().min(0).optional(),
    retry_backoff_ms: z.number().int().min(0).optional(),
    quiet: z.boolean().optional(),
    inference_profile: z.string().min(1).optional(),
    timeout_ms: z.number().int().positive().optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

function parseScheduleConfig(
  raw: unknown,
): { config: PluginScheduleConfig } | { error: string } {
  const result = scheduleConfigSchema.safeParse(raw);
  if (!result.success) {
    const detail = result.error.issues
      .map((i) => `${i.path.join(".") || "config"}: ${i.message}`)
      .join("; ");
    return { error: `invalid config: ${detail}` };
  }
  const fields = result.data;

  if (fields.timeout_ms !== undefined) {
    const timeoutError = validateScriptTimeoutMs(fields.timeout_ms);
    if (timeoutError) {
      return { error: timeoutError };
    }
  }

  const resolved = normalizeScheduleSyntax({
    syntax: fields.expression_syntax,
    expression: fields.expression,
  });
  if (!resolved) {
    return {
      error: `could not determine syntax for expression "${fields.expression}"; set expression_syntax to "cron" or "rrule"`,
    };
  }
  if (resolved.syntax === "rrule") {
    const setError = validateRruleSetLines(resolved.expression);
    if (setError) {
      return { error: setError };
    }
    if (isSingleFireRRule(resolved.expression)) {
      return {
        error:
          "expression fires exactly once (COUNT=1): declared schedules must be recurring",
      };
    }
  }
  if (
    !isValidScheduleExpression({
      syntax: resolved.syntax,
      expression: resolved.expression,
      timezone: fields.timezone ?? null,
    })
  ) {
    return {
      error: `invalid ${resolved.syntax} expression "${fields.expression}"${
        fields.timezone ? ` (timezone "${fields.timezone}")` : ""
      }`,
    };
  }
  if (resolved.syntax === "rrule") {
    // A syntactically valid recurrence can still be exhausted (UNTIL in the
    // past, COUNT consumed). Such a schedule has no firing left, so it fails
    // closed here as a declaration error rather than surviving to throw on
    // every reconcile upsert.
    try {
      computeNextRunAt({
        syntax: resolved.syntax,
        expression: resolved.expression,
        timezone: fields.timezone ?? null,
      });
    } catch {
      return {
        error:
          "expression has no upcoming occurrences: the recurrence has already ended",
      };
    }
  }

  return {
    config: {
      expression: resolved.expression,
      syntax: resolved.syntax,
      timezone: fields.timezone ?? null,
      description: fields.description ?? null,
      maxRetries: fields.max_retries ?? null,
      retryBackoffMs: fields.retry_backoff_ms ?? null,
      quiet: fields.quiet ?? null,
      inferenceProfile: fields.inference_profile ?? null,
      timeoutMs: fields.timeout_ms ?? null,
      enabled: fields.enabled ?? true,
    },
  };
}

interface DeclarationFile {
  relPath: string;
  content: Buffer;
}

function hashDeclarationFiles(files: DeclarationFile[]): string {
  const sorted = [...files].sort((a, b) =>
    a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0,
  );
  const hash = createHash("sha256");
  for (const file of sorted) {
    hash.update(file.relPath);
    hash.update("\0");
    hash.update(file.content);
    hash.update("\0");
  }
  return hash.digest("hex");
}

/**
 * Collect every regular file under `dir` (recursively, dot entries and
 * symlinks skipped) with paths relative to the schedules/ root.
 */
function collectDeclarationFiles(
  dir: string,
  relPrefix: string,
): DeclarationFile[] {
  const files: DeclarationFile[] = [];
  walkPluginTree(dir, { excludeDotEntries: true }, (rel, abs) => {
    files.push({ relPath: `${relPrefix}${rel}`, content: readFileSync(abs) });
  });
  return files;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Shell invocation for a declaration's `index.sh`. The script always runs
 * through an explicit interpreter rather than being executed directly, which
 * keeps the entrypoint runnable when an install path drops its exec bit. A
 * `#!` first line names that interpreter plus at most one argument (the
 * kernel's own shebang contract, covering both `#!/bin/bash` and
 * `#!/usr/bin/env bash`); a script without one is parsed by `sh`.
 */
function buildScriptInvocation(scriptPath: string, content: string): string {
  const firstLine = content.split(/\r?\n/, 1)[0] ?? "";
  if (firstLine.startsWith("#!")) {
    const rest = firstLine.slice(2).trim();
    const spaceIdx = rest.search(/\s/);
    const interpreter = spaceIdx === -1 ? rest : rest.slice(0, spaceIdx);
    const argument = spaceIdx === -1 ? "" : rest.slice(spaceIdx).trim();
    if (interpreter) {
      return [interpreter, ...(argument ? [argument] : []), scriptPath]
        .map(shellQuote)
        .join(" ");
    }
  }
  return `sh ${shellQuote(scriptPath)}`;
}

const SUPPORTED_ENTRYPOINTS = ["index.md", "index.sh"];

interface ParsedDeclarationBody {
  mode: PluginScheduleMode;
  message: string | null;
  scriptInvocation: string | null;
  config: PluginScheduleConfig;
  files: DeclarationFile[];
}

function parseFlatDeclaration(
  schedulesDir: string,
  fileName: string,
): ParsedDeclarationBody | { error: string } {
  const content = readFileSync(join(schedulesDir, fileName), "utf8");
  const parsed = parseFrontmatterFields(content);
  if (!parsed) {
    // parseFrontmatterFields returns null for both a missing block and
    // malformed YAML; the regex distinguishes the two.
    return FRONTMATTER_REGEX.test(content)
      ? { error: "invalid YAML frontmatter" }
      : {
          error:
            "missing frontmatter: schedule config (expression, ...) is required",
        };
  }
  const configResult = parseScheduleConfig(parsed.fields);
  if ("error" in configResult) {
    return configResult;
  }
  const message = parsed.body.trim();
  if (!message) {
    return { error: "prompt body is empty" };
  }
  return {
    mode: "execute",
    message,
    scriptInvocation: null,
    config: configResult.config,
    files: [{ relPath: fileName, content: Buffer.from(content) }],
  };
}

function parseDirectoryDeclaration(
  schedulesDir: string,
  dirName: string,
): ParsedDeclarationBody | { error: string } {
  const dirPath = join(schedulesDir, dirName);
  const children = readdirSync(dirPath, { withFileTypes: true });

  const entrypoints = children
    .filter((c) => c.isFile() && c.name.startsWith("index."))
    .map((c) => c.name)
    .sort();
  if (entrypoints.length === 0) {
    return {
      error: "no entrypoint: expected exactly one of index.md or index.sh",
    };
  }
  if (entrypoints.length > 1) {
    return {
      error: `multiple entrypoints (${entrypoints.join(", ")}): expected exactly one of index.md or index.sh`,
    };
  }
  const entrypoint = entrypoints[0]!;
  if (!SUPPORTED_ENTRYPOINTS.includes(entrypoint)) {
    return {
      error: `unsupported entrypoint "${entrypoint}": expected index.md or index.sh`,
    };
  }

  let rawConfigText: string;
  try {
    rawConfigText = readFileSync(join(dirPath, "config.json"), "utf8");
  } catch {
    return { error: "missing config.json" };
  }
  let rawConfig: unknown;
  try {
    rawConfig = JSON.parse(rawConfigText);
  } catch (err) {
    return {
      error: `config.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const configResult = parseScheduleConfig(rawConfig);
  if ("error" in configResult) {
    return configResult;
  }

  let message: string | null = null;
  let scriptInvocation: string | null = null;
  let mode: PluginScheduleMode;
  if (entrypoint === "index.md") {
    const content = readFileSync(join(dirPath, "index.md"), "utf8");
    if (FRONTMATTER_REGEX.test(content)) {
      return {
        error:
          "index.md must not contain frontmatter: directory-form config belongs in config.json",
      };
    }
    message = content.trim();
    if (!message) {
      return { error: "prompt body is empty" };
    }
    mode = "execute";
  } else {
    const scriptPath = join(dirPath, "index.sh");
    scriptInvocation = buildScriptInvocation(
      scriptPath,
      readFileSync(scriptPath, "utf8"),
    );
    mode = "script";
  }

  return {
    mode,
    message,
    scriptInvocation,
    config: configResult.config,
    files: collectDeclarationFiles(dirPath, `${dirName}/`),
  };
}

/**
 * Parse every schedule declaration under `<pluginDir>/schedules/`. A missing
 * or unreadable schedules/ directory yields no declarations and no errors.
 * Every malformed or ambiguous declaration yields a per-schedule
 * {@link DeclarationError} without affecting siblings.
 */
export function parsePluginScheduleDeclarations(
  pluginDir: string,
  pluginName: string,
): ParsedPluginSchedules {
  const schedulesDir = join(pluginDir, "schedules");
  let entries;
  try {
    entries = readdirSync(schedulesDir, { withFileTypes: true });
  } catch {
    return { declarations: [], errors: [] };
  }

  const declarations: ScheduleDeclaration[] = [];
  const errors: DeclarationError[] = [];
  const fail = (scheduleName: string, reason: string): void => {
    errors.push({
      pluginName,
      scheduleName,
      sourceKey: pluginScheduleSourceKey(pluginName, scheduleName),
      reason,
    });
  };

  const flatNames = new Map<string, string>();
  const dirNames = new Set<string>();
  for (const entry of entries) {
    if (entry.name.startsWith(".")) {
      continue;
    }
    if (entry.isDirectory()) {
      dirNames.add(entry.name);
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      flatNames.set(entry.name.slice(0, -".md".length), entry.name);
    } else {
      fail(
        entry.name,
        `unsupported entry "${entry.name}": expected <name>.md or a <name>/ directory`,
      );
    }
  }

  for (const name of flatNames.keys()) {
    if (dirNames.has(name)) {
      fail(
        name,
        `declared as both ${name}.md and ${name}/ directory: remove one form`,
      );
      flatNames.delete(name);
      dirNames.delete(name);
    }
  }

  const parseOne = (
    name: string,
    parse: () => ParsedDeclarationBody | { error: string },
  ): void => {
    let result: ParsedDeclarationBody | { error: string };
    try {
      result = parse();
    } catch (err) {
      result = {
        error: `failed to read declaration: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if ("error" in result) {
      fail(name, result.error);
      return;
    }
    declarations.push({
      sourceKey: pluginScheduleSourceKey(pluginName, name),
      name,
      mode: result.mode,
      message: result.message,
      scriptInvocation: result.scriptInvocation,
      config: result.config,
      definitionHash: hashDeclarationFiles(result.files),
    });
  };

  for (const [name, fileName] of flatNames) {
    parseOne(name, () => parseFlatDeclaration(schedulesDir, fileName));
  }
  for (const name of dirNames) {
    parseOne(name, () => parseDirectoryDeclaration(schedulesDir, name));
  }

  declarations.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  errors.sort((a, b) =>
    a.scheduleName < b.scheduleName
      ? -1
      : a.scheduleName > b.scheduleName
        ? 1
        : 0,
  );
  return { declarations, errors };
}
