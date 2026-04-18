/**
 * pkb-context-tracker
 *
 * Pure helper that reports which PKB file paths are already "in context" for
 * a given conversation. A path is considered in context if either:
 *
 *   1. It was explicitly auto-injected (caller supplies `autoInjectPaths`),
 *      typically via a system-reminder that embeds the file contents.
 *   2. The conversation history contains a structured `file_read` tool_use
 *      block whose `input.path` — resolved the same way `file_read` itself
 *      resolves it (absolute as-is, relative against `workingDir`) — lands
 *      inside `pkbRoot`.
 *
 * Used by the PKB system reminder so we don't suggest files the model has
 * already loaded.
 *
 * Post-compaction note: structured `tool_use` blocks get serialized into a
 * plain-text summary and dropped from the live message array. After a
 * compaction, this helper will naturally only see the `autoInjectPaths` —
 * which is the desired semantics.
 *
 * No I/O, no globals, no side effects.
 */

import path from "node:path";

import type { ContentBlock, Message } from "../providers/types.js";

/**
 * Minimal shape this helper needs from a `Conversation`. Defining it as an
 * interface (rather than importing the full `Conversation` class) keeps the
 * helper pure and trivial to unit-test without constructing a real daemon
 * conversation.
 */
export interface PkbContextConversation {
  messages: Message[];
}

/**
 * The structured tool_use block name the assistant emits when reading files
 * from the workspace (see `assistant/src/tools/filesystem/read.ts`).
 */
const FILE_READ_TOOL_NAME = "file_read";

/**
 * Resolve `candidate` against `pkbRoot` and return the absolute path ONLY if
 * it stays inside `pkbRoot`. Otherwise return `undefined`. Guards against
 * `..`-style path traversal.
 */
function resolveInsidePkbRoot(
  candidate: string,
  pkbRoot: string,
): string | undefined {
  if (typeof candidate !== "string" || candidate.length === 0) {
    return undefined;
  }
  const resolved = path.resolve(pkbRoot, candidate);
  // `path.resolve` normalizes any `..` segments in `candidate`. We still need
  // to verify the result is inside `pkbRoot`. Comparing with a trailing
  // separator avoids treating `<pkbRoot>somethingElse` as inside the root.
  if (resolved === pkbRoot) {
    return resolved;
  }
  const rootWithSep = pkbRoot.endsWith(path.sep) ? pkbRoot : pkbRoot + path.sep;
  if (resolved.startsWith(rootWithSep)) {
    return resolved;
  }
  return undefined;
}

/**
 * Returns the set of absolute PKB file paths already in the conversation's
 * in-memory context. This is the union of `autoInjectPaths` (resolved into
 * `pkbRoot`) and any `file_read` tool_use block inputs found in
 * `conversation.messages` that resolve inside `pkbRoot`.
 *
 * `file_read` resolves its `path` argument against `workingDir` (the tool's
 * working directory), so this helper mirrors that rule: relative tool paths
 * are resolved against `workingDir`, absolute paths are taken as-is, and the
 * resulting absolute path is then accepted only if it falls inside `pkbRoot`.
 *
 * Paths outside `pkbRoot` (including `..`-traversal attempts) are excluded.
 * Tool uses whose `name` is not `file_read` are ignored.
 */
export function getInContextPkbPaths(
  conversation: PkbContextConversation,
  autoInjectPaths: string[],
  pkbRoot: string,
  workingDir: string,
): Set<string> {
  const normalizedRoot = path.resolve(pkbRoot);
  const normalizedWorkingDir = path.resolve(workingDir);
  const inContext = new Set<string>();

  for (const candidate of autoInjectPaths) {
    const resolved = resolveInsidePkbRoot(candidate, normalizedRoot);
    if (resolved !== undefined) {
      inContext.add(resolved);
    }
  }

  for (const message of conversation.messages) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content as ContentBlock[]) {
      if (block.type !== "tool_use") continue;
      if (block.name !== FILE_READ_TOOL_NAME) continue;
      const rawPath = block.input?.path;
      if (typeof rawPath !== "string" || rawPath.length === 0) continue;
      // Mirror `file_read`'s own path resolution: absolute paths are taken
      // as-is; relative paths resolve against the tool's working directory
      // (NOT `pkbRoot`). Resolving relative paths against `pkbRoot` would
      // double-prefix workspace-relative inputs like `pkb/threads.md` into
      // `<pkbRoot>/pkb/threads.md` and miss the actually-loaded file.
      const absolute = path.isAbsolute(rawPath)
        ? path.resolve(rawPath)
        : path.resolve(normalizedWorkingDir, rawPath);
      const resolved = resolveInsidePkbRoot(absolute, normalizedRoot);
      if (resolved !== undefined) {
        inContext.add(resolved);
      }
    }
  }

  return inContext;
}
