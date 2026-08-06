/**
 * Parser for plugin-declared schedules under `<pluginDir>/schedules/`.
 *
 * A declaration is a directory: `<name>/` containing `config.json` (the
 * schedule config) plus exactly one entrypoint, `index.md` (mode `execute`,
 * body is the prompt) or `index.sh` (mode `script`, invoked by absolute path
 * via its shebang interpreter, or `sh` when it has none). A file sitting
 * directly under `schedules/` is not a declaration; it yields a
 * {@link DeclarationError} of its own so the author is told rather than left
 * wondering why nothing loaded.
 *
 * Ambiguity fails closed, never resolves by precedence: a directory with zero
 * or multiple entrypoints, or an unsupported entrypoint, yields a
 * {@link DeclarationError} and the schedule does not load. Errors are
 * per-schedule; one bad declaration never blocks siblings.
 *
 * Declared schedules are recurring only: `expression` is required, a
 * single-fire RRULE (COUNT=1) is rejected, and there is no one-shot form.
 *
 * Pure filesystem + parsing. This module must not import from persistence or
 * schedule-store; the reconciler owns all database interaction.
 */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import { isPluginDisabled } from "../plugins/disabled-state.js";
import { parsePluginManifest } from "../plugins/external-plugin-loader.js";
import { isInsidePluginRoot } from "../plugins/installed-plugin-dirs.js";
import { walkPluginTree } from "../plugins/plugin-tree-walk.js";
import { FRONTMATTER_REGEX } from "../skills/frontmatter.js";
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

/** Normalized schedule config parsed from a declaration's config.json. */
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

/**
 * Why a declaration did not load.
 *
 * `invalid` is a broken declaration and needs a fix in the plugin. `ended` is
 * a well-formed recurrence with nothing left to fire, its COUNT consumed or
 * its UNTIL past. A bounded schedule that ran to completion reaches that
 * state on its own, so the reconciler surfaces it only when the row it
 * belongs to is still armed, or when there is no row at all.
 */
export type DeclarationErrorKind = "invalid" | "ended";

export interface DeclarationError {
  pluginName: string;
  scheduleName: string;
  sourceKey: string;
  reason: string;
  kind: DeclarationErrorKind;
}

/** A declaration that did not load, before it is keyed to a plugin. */
interface DeclarationFailure {
  error: string;
  kind?: DeclarationErrorKind;
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
 * (`plugin:<pluginName>/<scheduleName>`) is available to arm a row: its
 * `schedules/<scheduleName>/` directory is present on disk and contained, the
 * plugin is not disabled, and the plugin's manifest parses. Each of the latter
 * two counts as absent for the same reason: the reconciler disarms the
 * schedules of a disabled plugin and of one whose `package.json` the loader
 * rejects, so neither may be re-armed from a stale row while its files sit on
 * disk. Presence and sourceability only; the declaration's own validity is the
 * reconciler's business.
 *
 * Containment is checked on both directories through
 * {@link isInsidePluginRoot}, the same boundary the plugin loader applies: the
 * plugin root must resolve inside the plugins directory and the declaration
 * directory inside its plugin root. A row's stored script invocation names an
 * absolute entrypoint path, so a link swapped in under either one would
 * otherwise let this probe answer for one tree while the schedule executes
 * code from another. A link that stays inside its root is a normal install
 * layout and passes.
 */
export async function declarationExistsOnDisk(
  sourceKey: string,
): Promise<boolean> {
  const match = /^plugin:([^/]+)\/(.+)$/.exec(sourceKey);
  if (!match) {
    return false;
  }
  const [, pluginName, scheduleName] = match;
  if (isPluginDisabled(pluginName!)) {
    return false;
  }
  const pluginsDir = getWorkspacePluginsDir();
  const pluginDir = join(pluginsDir, pluginName!);
  if (!isInsidePluginRoot(pluginDir, pluginsDir)) {
    return false;
  }
  const declarationDir = join(pluginDir, "schedules", scheduleName!);
  if (!statSync(declarationDir, { throwIfNoEntry: false })?.isDirectory()) {
    return false;
  }
  if (!isInsidePluginRoot(declarationDir, pluginDir)) {
    return false;
  }
  return (await parsePluginManifest(pluginDir, { quiet: true })) !== undefined;
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
): { config: PluginScheduleConfig } | DeclarationFailure {
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
    // closed here rather than surviving to throw on every reconcile upsert.
    // The `ended` kind separates it from a broken declaration, since a
    // bounded recurrence that simply ran its course is not something the
    // plugin author has to fix.
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
        kind: "ended",
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

function parseDirectoryDeclaration(
  schedulesDir: string,
  dirName: string,
): ParsedDeclarationBody | DeclarationFailure {
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
  const fail = (
    scheduleName: string,
    reason: string,
    kind: DeclarationErrorKind = "invalid",
  ): void => {
    errors.push({
      pluginName,
      scheduleName,
      sourceKey: pluginScheduleSourceKey(pluginName, scheduleName),
      reason,
      kind,
    });
  };

  const dirNames: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) {
      continue;
    }
    if (entry.isDirectory()) {
      dirNames.push(entry.name);
    } else {
      fail(
        entry.name,
        `schedule declarations must be directories (schedules/<name>/ holding config.json and one index.md or index.sh): "${entry.name}" is a file`,
      );
    }
  }

  const parseOne = (
    name: string,
    parse: () => ParsedDeclarationBody | DeclarationFailure,
  ): void => {
    let result: ParsedDeclarationBody | DeclarationFailure;
    try {
      result = parse();
    } catch (err) {
      result = {
        error: `failed to read declaration: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if ("error" in result) {
      fail(name, result.error, result.kind);
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
