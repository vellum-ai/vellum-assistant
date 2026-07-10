/**
 * Declarative tool manifest - single place to inspect what gets registered.
 *
 * Each entry describes HOW a tool (or group of tools) gets loaded and
 * registered.  `initializeTools()` in `registry.ts` iterates this list
 * so adding/removing tools only requires editing this manifest.
 */

import { recallTool, rememberTool } from "../plugins/defaults/memory/tools.js";
import { askQuestionTool } from "./ask-question/ask-question-tool.js";
import { fileEditTool } from "./filesystem/edit.js";
import { fileListTool } from "./filesystem/list.js";
import { fileReadTool } from "./filesystem/read.js";
import { codeSearchTool } from "./filesystem/search.js";
import { fileWriteTool } from "./filesystem/write.js";
import { hostFileEditTool } from "./host-filesystem/edit.js";
import { hostFileReadTool } from "./host-filesystem/read.js";
import { hostFileTransferTool } from "./host-filesystem/transfer.js";
import { hostFileWriteTool } from "./host-filesystem/write.js";
import { hostShellTool } from "./host-terminal/host-shell.js";
import { webFetchTool } from "./network/web-fetch.js";
import { webSearchTool } from "./network/web-search.js";
import { skillExecuteTool } from "./skills/execute.js";
import { skillLoadTool } from "./skills/load.js";
import { notifyParentTool } from "./subagent/notify-parent.js";
import { requestSystemPermissionTool } from "./system/request-permission.js";
import { shellTool } from "./terminal/shell.js";
import type { ToolDefinition } from "./types.js";

// ── Explicit tool instances ─────────────────────────────────────────
// Core tools registered by initializeTools(). Tool modules only export
// their definitions — registration happens exclusively here, so importing
// a tool module never mutates the registry.
//
// IMPORTANT: The imports above MUST be static (not dynamic `await import()`).
// When the daemon is compiled with `bun --compile`, dynamic imports with
// relative string literals resolve against the virtual `/$bunfs/root/`
// filesystem root rather than the module's own directory, causing
// "Cannot find module './filesystem/read.js'" crashes in production builds.
// Static imports are resolved at bundle time and are always safe.

export const explicitTools: ToolDefinition[] = [
  shellTool,
  fileReadTool,
  fileWriteTool,
  fileEditTool,
  fileListTool,
  codeSearchTool,
  webFetchTool,
  webSearchTool,
  skillExecuteTool,
  skillLoadTool,
  requestSystemPermissionTool,
  rememberTool,
  recallTool,
  notifyParentTool,
  askQuestionTool,
  // Host tools — executed on the desktop host via the client proxy rather
  // than in the daemon's sandbox. Listed after the sandbox tools so
  // registration order (and thus tools.json ordering) is stable.
  hostFileReadTool,
  hostFileWriteTool,
  hostFileEditTool,
  hostFileTransferTool,
  hostShellTool,
];
