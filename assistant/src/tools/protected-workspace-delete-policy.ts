/**
 * Hard-deny deletes of workspace files the assistant must not remove.
 *
 * Prompt surfaces stay editable in place (file_write / file_edit). Deleting
 * them (or config.json) is a footgun: the config loader rewrites schema
 * defaults when config.json is gone, and identity files re-seed from
 * templates. This is not an adversarial sandbox. It covers the shell
 * tools the model actually uses for cleanup (`rm`, `unlink`, `git rm`,
 * `find -delete`, and a workspace-root wipe).
 */

import { basename, relative, resolve, sep } from "node:path";

import {
  PROMPT_SURFACE_DIRS,
  PROMPT_SURFACE_FILES,
  resolveSandboxBase,
} from "../permissions/workspace-policy.js";

const SHELL_TOOLS = new Set(["bash", "host_bash"]);

/**
 * Workspace-relative files that must survive an assistant `rm`. Prompt
 * surfaces match {@link PROMPT_SURFACE_FILES}. `config.json` is runtime
 * state: the loader writes schema defaults when it is missing.
 */
export const PROTECTED_FROM_DELETE_FILES = [
  "config.json",
  ...PROMPT_SURFACE_FILES,
  "USER.md",
  "ui/theme.json",
] as const;

export const PROTECTED_FROM_DELETE_DIRS = PROMPT_SURFACE_DIRS;

const WRAPPER_COMMANDS = new Set([
  "sudo",
  "doas",
  "command",
  "nice",
  "nohup",
  "time",
  "stdbuf",
  "ionice",
  "then",
  "builtin",
]);

export type ProtectedDeleteDenial = {
  denied: true;
  reason: string;
  target: string;
};

export type ProtectedDeleteResult =
  | { denied: false }
  | ProtectedDeleteDenial;

function tokenize(segment: string): string[] {
  const tokens: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(segment)) !== null) {
    const token = match[1] ?? match[2] ?? match[3] ?? "";
    if (token.length > 0) {
      tokens.push(token);
    }
  }
  return tokens;
}

function splitSegments(command: string): string[] {
  return command.split(/(?:&&|\|\||;|\n|\|)/);
}

function peelWrappers(tokens: string[]): string[] {
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i];
    if (token === undefined) {
      break;
    }
    if (token === "sudo" || token === "doas") {
      i += 1;
      while (i < tokens.length && (tokens[i] ?? "").startsWith("-")) {
        i += 1;
      }
      continue;
    }
    if (token === "command" || token === "builtin") {
      i += 1;
      while (i < tokens.length && (tokens[i] ?? "").startsWith("-")) {
        i += 1;
      }
      continue;
    }
    if (token === "env") {
      i += 1;
      while (i < tokens.length) {
        const next = tokens[i] ?? "";
        if (next.startsWith("-") || next.includes("=")) {
          i += 1;
          continue;
        }
        break;
      }
      continue;
    }
    if (token === "timeout") {
      i += 1;
      while (i < tokens.length) {
        const next = tokens[i] ?? "";
        if (next.startsWith("-") || /^\d/.test(next)) {
          i += 1;
          continue;
        }
        break;
      }
      continue;
    }
    if (WRAPPER_COMMANDS.has(token)) {
      i += 1;
      while (i < tokens.length && (tokens[i] ?? "").startsWith("-")) {
        i += 1;
      }
      continue;
    }
    break;
  }
  return tokens.slice(i);
}

function isRecursiveFlag(arg: string): boolean {
  if (arg === "-r" || arg === "-R" || arg === "--recursive") {
    return true;
  }
  if (arg.startsWith("--")) {
    return false;
  }
  if (!arg.startsWith("-") || arg.length < 2) {
    return false;
  }
  return arg.includes("r") || arg.includes("R");
}

function collectPositionalArgs(args: string[]): {
  paths: string[];
  recursive: boolean;
  cachedOnly: boolean;
} {
  const paths: string[] = [];
  let recursive = false;
  let cachedOnly = false;
  let endFlags = false;
  for (const arg of args) {
    if (!endFlags && arg === "--") {
      endFlags = true;
      continue;
    }
    if (!endFlags && arg.startsWith("-")) {
      if (isRecursiveFlag(arg)) {
        recursive = true;
      }
      if (arg === "--cached") {
        cachedOnly = true;
      }
      continue;
    }
    paths.push(arg);
  }
  return { paths, recursive, cachedOnly };
}

function posixRelative(from: string, to: string): string {
  return relative(from, to).split("\\").join("/");
}

function isProtectedFile(
  rawPath: string,
  workspaceRoot: string,
): string | null {
  const resolved = resolveSandboxBase(rawPath, workspaceRoot);
  const rel = posixRelative(resolve(workspaceRoot), resolved);
  if (rel === "" || rel.startsWith("..")) {
    return null;
  }
  if ((PROTECTED_FROM_DELETE_FILES as readonly string[]).includes(rel)) {
    return rel;
  }
  const top = rel.split("/")[0];
  if (
    top !== undefined &&
    (PROTECTED_FROM_DELETE_DIRS as readonly string[]).includes(top)
  ) {
    return rel;
  }
  return null;
}

function stripTrailingSlashes(path: string): string {
  if (path === "/") {
    return "/";
  }
  const trimmed = path.replace(/\/+$/, "");
  return trimmed.length > 0 ? trimmed : "/";
}

function isWorkspaceWideTarget(rawPath: string, workspaceRoot: string): boolean {
  const trimmed = stripTrailingSlashes(rawPath);
  if (trimmed === "/" || trimmed === "") {
    return false;
  }
  if (
    trimmed === "." ||
    trimmed === "*" ||
    trimmed === "./*" ||
    trimmed === "./**" ||
    trimmed === "/workspace" ||
    trimmed === "/workspace/*"
  ) {
    return true;
  }
  const withoutGlob = stripTrailingSlashes(trimmed.replace(/\/\*$/, ""));
  if (withoutGlob === "/") {
    return false;
  }
  const resolved = resolveSandboxBase(withoutGlob, workspaceRoot);
  return resolve(resolved) === resolve(workspaceRoot);
}

function denial(target: string): ProtectedDeleteDenial {
  if (target === "." || target === "/workspace" || target.endsWith("/*")) {
    return {
      denied: true,
      target,
      reason:
        "Cannot delete the workspace root. That would remove required assistant state such as config.json and SOUL.md. Delete specific non-protected paths instead.",
    };
  }
  return {
    denied: true,
    target,
    reason: `Cannot delete ${basename(target)}. That file is required assistant state. Edit it in place, or change config.json through Settings.`,
  };
}

function inspectRmLike(
  paths: string[],
  workspaceRoot: string,
  options: { recursive: boolean; cachedOnly: boolean },
): ProtectedDeleteResult {
  if (options.cachedOnly) {
    return { denied: false };
  }
  for (const path of paths) {
    if (isWorkspaceWideTarget(path, workspaceRoot)) {
      return denial(path);
    }
    const hit = isProtectedFile(path, workspaceRoot);
    if (hit) {
      return denial(hit);
    }
  }
  return { denied: false };
}

function inspectFind(
  tokens: string[],
  workspaceRoot: string,
): ProtectedDeleteResult {
  const deletes =
    tokens.includes("-delete") ||
    tokens.some(
      (token, index) => token === "-exec" && tokens[index + 1] === "rm",
    );
  if (!deletes) {
    return { denied: false };
  }
  const searchPaths: string[] = [];
  for (let i = 1; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === undefined) {
      break;
    }
    if (token.startsWith("-")) {
      break;
    }
    searchPaths.push(token);
  }
  if (searchPaths.length === 0) {
    searchPaths.push(".");
  }
  return inspectRmLike(searchPaths, workspaceRoot, {
    recursive: true,
    cachedOnly: false,
  });
}

function inspectGitRm(
  tokens: string[],
  workspaceRoot: string,
): ProtectedDeleteResult {
  const rmIndex = tokens.findIndex((token) => token === "rm");
  if (rmIndex === -1) {
    return { denied: false };
  }
  const collected = collectPositionalArgs(tokens.slice(rmIndex + 1));
  return inspectRmLike(collected.paths, workspaceRoot, {
    recursive: collected.recursive,
    cachedOnly: collected.cachedOnly,
  });
}

function inspectSegment(
  segment: string,
  workspaceRoot: string,
): ProtectedDeleteResult {
  const peeled = peelWrappers(tokenize(segment));
  if (peeled.length === 0) {
    return { denied: false };
  }
  const verb = peeled[0];
  if (verb === "rm" || verb === "unlink" || verb === "rmdir") {
    const collected = collectPositionalArgs(peeled.slice(1));
    return inspectRmLike(collected.paths, workspaceRoot, {
      recursive: collected.recursive || verb === "rmdir",
      cachedOnly: false,
    });
  }
  if (verb === "mv") {
    const collected = collectPositionalArgs(peeled.slice(1));
    if (collected.paths.length >= 1) {
      const source = collected.paths[0];
      if (source !== undefined) {
        const hit = isProtectedFile(source, workspaceRoot);
        if (hit) {
          return denial(hit);
        }
      }
    }
    return { denied: false };
  }
  if (verb === "git") {
    return inspectGitRm(peeled.slice(1), workspaceRoot);
  }
  if (verb === "find") {
    return inspectFind(peeled, workspaceRoot);
  }
  return { denied: false };
}

/**
 * Whether a shell command would delete a protected workspace file or wipe
 * the workspace root.
 */
export function commandDeletesProtectedWorkspaceFile(
  command: string,
  workspaceRoot: string,
): ProtectedDeleteResult {
  if (!workspaceRoot) {
    return { denied: false };
  }
  for (const segment of splitSegments(command)) {
    const result = inspectSegment(segment.trim(), workspaceRoot);
    if (result.denied) {
      return result;
    }
  }
  return { denied: false };
}

/**
 * Enforce the delete allowlist on bash / host_bash. Other tools are ignored.
 */
export function enforceProtectedWorkspaceDeletePolicy(
  toolName: string,
  input: Record<string, unknown>,
  workspaceRoot: string,
): ProtectedDeleteResult {
  if (!SHELL_TOOLS.has(toolName)) {
    return { denied: false };
  }
  const command = input.command;
  if (typeof command !== "string" || command.length === 0) {
    return { denied: false };
  }
  return commandDeletesProtectedWorkspaceFile(command, workspaceRoot);
}

export function isProtectedFromDeleteRelPath(relPath: string): boolean {
  const normalized = relPath.split(sep).join("/");
  if ((PROTECTED_FROM_DELETE_FILES as readonly string[]).includes(normalized)) {
    return true;
  }
  const top = normalized.split("/")[0];
  return (
    top !== undefined &&
    (PROTECTED_FROM_DELETE_DIRS as readonly string[]).includes(top)
  );
}
