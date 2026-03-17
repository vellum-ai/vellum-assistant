import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { Language, type Node as TSNode, Parser } from "web-tree-sitter";

import { IntegrityError } from "../../util/errors.js";
import { getLogger } from "../../util/logger.js";
import { PromiseGuard } from "../../util/promise-guard.js";

const log = getLogger("shell-parser");

export type DangerousPatternType =
  | "pipe_to_shell"
  | "base64_execute"
  | "process_substitution"
  | "sensitive_redirect"
  | "dangerous_substitution"
  | "env_injection";

export interface DangerousPattern {
  type: DangerousPatternType;
  description: string;
  text: string;
}

export interface CommandSegment {
  command: string;
  program: string;
  args: string[];
  operator: "&&" | "||" | ";" | "|" | "";
}

export interface ParsedCommand {
  segments: CommandSegment[];
  dangerousPatterns: DangerousPattern[];
  hasOpaqueConstructs: boolean;
}

const SHELL_PROGRAMS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"]);
// Script interpreters that can execute arbitrary code from stdin - piping
// untrusted data into these is as dangerous as piping into a shell.
const SCRIPT_INTERPRETERS = new Set([
  "python",
  "python3",
  "ruby",
  "perl",
  "node",
  "deno",
  "bun",
]);
// Flags that make an interpreter execute code from an inline argument or stdin
// rather than from a file (e.g. `python -c 'code'`, `node -e 'code'`).
const STDIN_EXEC_FLAGS = new Set(["-c", "-e", "-"]);
// Per-interpreter flags that consume the next argument as a value (not a filename).
// Mapped by interpreter name since flags differ across interpreters
// (e.g. -I is standalone in Python but takes a value in Ruby).
// Note: `-m` is intentionally excluded - it means "run module", so the next arg
// is a module name and the interpreter is NOT in stdin-exec mode.
const INTERPRETER_VALUE_FLAGS: ReadonlyMap<
  string,
  ReadonlySet<string>
> = new Map([
  ["python", new Set(["-W", "-X", "-Q"])],
  ["python3", new Set(["-W", "-X", "-Q"])],
  ["ruby", new Set(["-r", "--require", "-I"])],
  ["node", new Set(["-r", "--require", "--import", "--conditions"])],
  ["deno", new Set()],
  ["bun", new Set()],
  ["perl", new Set(["-I"])],
]);
const OPAQUE_PROGRAMS = new Set(["eval", "source", "alias"]);
const DANGEROUS_ENV_VARS = new Set([
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "DYLD_FRAMEWORK_PATH",
  "NODE_OPTIONS",
  "NODE_PATH",
  "PATH",
  "PYTHONPATH",
  "RUBYLIB",
]);
const SENSITIVE_PATH_PREFIXES = [
  "~/.zshrc",
  "~/.bashrc",
  "~/.bash_profile",
  "~/.profile",
  "~/.ssh/",
  "~/.gnupg/",
  "~/.config/",
  "/etc/",
  "/usr/lib/",
  "/usr/bin/",
];

// Expected SHA-256 checksums for WASM binaries.
// Update these when intentionally upgrading web-tree-sitter or tree-sitter-bash.
// Generate with: shasum -a 256 node_modules/web-tree-sitter/web-tree-sitter.wasm node_modules/tree-sitter-bash/tree-sitter-bash.wasm
const EXPECTED_CHECKSUMS: Record<string, string> = {
  "web-tree-sitter.wasm":
    "3d4c304cb7d59cfac4a2aa23c3408416cbfa2287fe17a9c975da46eb2ead8646",
  "tree-sitter-bash.wasm":
    "8292919c88a0f7d3fb31d0cd0253ca5a9531bc1ede82b0537f2c63dd8abe6a7a",
};

function verifyWasmChecksum(filePath: string, label: string): void {
  const data = readFileSync(filePath);
  const hash = createHash("sha256").update(data).digest("hex");
  const expected = EXPECTED_CHECKSUMS[label];
  if (!expected) {
    throw new IntegrityError(`No expected checksum registered for ${label}`);
  }
  if (hash !== expected) {
    throw new IntegrityError(
      `WASM integrity check failed for ${label}: expected ${expected}, got ${hash}`,
    );
  }
}

let parserInstance: Parser | null = null;
const initGuard = new PromiseGuard<void>();

/**
 * Locate a WASM file from a dependency package.
 *
 * In development / `bunx` the file lives under `node_modules/` relative
 * to the source tree.  In compiled Bun binaries `import.meta.dirname`
 * points into the virtual `/$bunfs/` filesystem where binary assets
 * don't exist - fall back to:
 *   1. `../Resources/<file>` (macOS .app bundle layout)
 *   2. Next to the compiled binary (process.execPath)
 * This matches the pattern used for compiled Bun binary asset resolution.
 */
function findWasmPath(
  pkg: string,
  file: string,
  resolvedPkgDir?: string,
): string {
  const dir = import.meta.dirname ?? __dirname;

  // In compiled Bun binaries, import.meta.dirname points into the virtual
  // /$bunfs/ filesystem.  Prefer bundled WASM assets shipped alongside the
  // executable before falling back to process.cwd(), so we never accidentally
  // pick up a mismatched version from the working directory.
  if (dir.startsWith("/$bunfs/")) {
    const execDir = dirname(process.execPath);
    // macOS .app bundle: binary is in Contents/MacOS/, resources in Contents/Resources/
    const resourcesPath = join(execDir, "..", "Resources", file);
    if (existsSync(resourcesPath)) return resourcesPath;
    // Next to the binary itself (non-app-bundle deployments)
    const execDirPath = join(execDir, file);
    if (existsSync(execDirPath)) return execDirPath;
    // Last resort: resolve from process.cwd() (the assistant/ directory)
    const cwdPath = join(process.cwd(), "node_modules", pkg, file);
    if (existsSync(cwdPath)) return cwdPath;
    return execDirPath;
  }

  // Use a pre-resolved package directory when available (callers pass this so
  // that static-analysis tools like knip can see the literal specifier).
  if (resolvedPkgDir) {
    const resolvedPath = join(resolvedPkgDir, file);
    if (existsSync(resolvedPath)) return resolvedPath;
  }

  // Fallback: dynamic module resolution. This handles hoisted dependencies
  // (e.g. global bun installs where web-tree-sitter is at the top-level
  // node_modules rather than nested under @vellumai/assistant).
  try {
    const resolved = require.resolve(`${pkg}/package.json`);
    const pkgDir = dirname(resolved);
    const resolvedPath = join(pkgDir, file);
    if (existsSync(resolvedPath)) return resolvedPath;
  } catch (err) {
    log.warn(
      { err, pkg, file },
      "require.resolve failed for WASM package, falling back to manual resolution",
    );
  }

  const sourcePath = join(dir, "..", "..", "..", "node_modules", pkg, file);

  if (existsSync(sourcePath)) return sourcePath;

  // Fallback: resolve from process.cwd() (the assistant/ directory).
  const cwdPath = join(process.cwd(), "node_modules", pkg, file);
  if (existsSync(cwdPath)) return cwdPath;

  return sourcePath;
}

async function ensureParser(): Promise<Parser> {
  if (parserInstance) return parserInstance;

  await initGuard.run(async () => {
    let webTreeSitterDir: string | undefined;
    try {
      webTreeSitterDir = dirname(
        require.resolve("web-tree-sitter/package.json"),
      );
    } catch {
      // Handled by findWasmPath fallbacks
    }
    let treeSitterBashDir: string | undefined;
    try {
      treeSitterBashDir = dirname(
        require.resolve("tree-sitter-bash/package.json"),
      );
    } catch {
      // Handled by findWasmPath fallbacks
    }

    const treeSitterWasm = findWasmPath(
      "web-tree-sitter",
      "web-tree-sitter.wasm",
      webTreeSitterDir,
    );
    const bashWasmPath = findWasmPath(
      "tree-sitter-bash",
      "tree-sitter-bash.wasm",
      treeSitterBashDir,
    );

    verifyWasmChecksum(treeSitterWasm, "web-tree-sitter.wasm");
    verifyWasmChecksum(bashWasmPath, "tree-sitter-bash.wasm");

    await Parser.init({
      locateFile: () => treeSitterWasm,
    });

    const Bash = await Language.load(bashWasmPath);
    const parser = new Parser();
    parser.setLanguage(Bash);
    parserInstance = parser;
    log.info(
      "Shell parser initialized (web-tree-sitter + bash, checksums verified)",
    );
  });

  return parserInstance!;
}

function extractSegments(node: TSNode): CommandSegment[] {
  const segments: CommandSegment[] = [];

  function walkNode(n: TSNode, operator: CommandSegment["operator"]): void {
    switch (n.type) {
      case "program": {
        for (const child of n.namedChildren) {
          walkNode(child, "");
        }
        break;
      }

      case "list": {
        // list = command (operator command)*
        for (let i = 0; i < n.childCount; i++) {
          const child = n.child(i);
          if (!child) continue;
          if (
            child.type === "&&" ||
            child.type === "||" ||
            child.type === ";"
          ) {
            operator = child.type as CommandSegment["operator"];
          } else if (child.type !== "comment") {
            walkNode(child, operator);
            operator = "";
          }
        }
        break;
      }

      case "pipeline": {
        let first = true;
        for (const child of n.namedChildren) {
          walkNode(child, first ? operator : "|");
          first = false;
        }
        break;
      }

      case "command": {
        const words: string[] = [];
        for (const child of n.namedChildren) {
          if (
            child.type === "command_name" ||
            child.type === "word" ||
            child.type === "string" ||
            child.type === "raw_string" ||
            child.type === "simple_expansion" ||
            child.type === "expansion" ||
            child.type === "command_substitution" ||
            child.type === "concatenation" ||
            child.type === "number"
          ) {
            words.push(child.text);
          }
        }
        if (words.length > 0) {
          segments.push({
            command: n.text,
            program: words[0],
            args: words.slice(1),
            operator,
          });
        }
        break;
      }

      case "redirected_statement": {
        for (const child of n.namedChildren) {
          if (
            child.type !== "file_redirect" &&
            child.type !== "heredoc_redirect" &&
            child.type !== "herestring_redirect"
          ) {
            walkNode(child, operator);
          }
        }
        break;
      }

      case "subshell":
      case "command_substitution":
      case "compound_statement":
      case "if_statement":
      case "while_statement":
      case "for_statement":
      case "case_statement":
      case "function_definition":
      case "negated_command": {
        for (const child of n.namedChildren) {
          walkNode(child, operator);
        }
        break;
      }

      default: {
        for (const child of n.namedChildren) {
          walkNode(child, operator);
        }
        break;
      }
    }
  }

  walkNode(node, "");
  return segments;
}

/**
 * Returns true when the interpreter args indicate stdin-exec mode - i.e. the
 * interpreter will read code from stdin (or from an inline -c/-e argument)
 * rather than from a file.  Concretely:
 *   - Any STDIN_EXEC_FLAGS present → stdin-exec
 *   - No positional (non-flag) arguments at all → stdin-exec (bare `python`)
 *   - Otherwise the first positional arg is a filename → NOT stdin-exec
 */
function isStdinExecMode(interpreter: string, args: string[]): boolean {
  const valueFlags =
    INTERPRETER_VALUE_FLAGS.get(interpreter) ?? new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (STDIN_EXEC_FLAGS.has(arg)) return true;
    // First non-flag argument is a filename/module → file mode
    if (!arg.startsWith("-")) return false;
    // Flags like -W, -X consume the next token as their value - skip it
    if (valueFlags.has(arg)) i++;
  }
  // No positional arguments at all → interpreter reads from stdin
  return true;
}

function detectDangerousPatterns(
  node: TSNode,
  segments: CommandSegment[],
): DangerousPattern[] {
  const patterns: DangerousPattern[] = [];

  for (let i = 1; i < segments.length; i++) {
    if (segments[i].operator === "|") {
      const prog = segments[i].program;
      if (SHELL_PROGRAMS.has(prog) || prog === "eval" || prog === "xargs") {
        patterns.push({
          type: "pipe_to_shell",
          description: `Pipeline into ${prog}`,
          text: segments[i].command,
        });
      } else if (
        SCRIPT_INTERPRETERS.has(prog) &&
        isStdinExecMode(prog, segments[i].args)
      ) {
        patterns.push({
          type: "pipe_to_shell",
          description: `Pipeline into ${prog}`,
          text: segments[i].command,
        });
      }
    }
  }

  for (let i = 0; i < segments.length - 1; i++) {
    if (segments[i].program === "base64" && segments[i].args.includes("-d")) {
      if (i + 1 < segments.length && segments[i + 1].operator === "|") {
        const nextProg = segments[i + 1].program;
        if (SHELL_PROGRAMS.has(nextProg) || nextProg === "eval") {
          patterns.push({
            type: "base64_execute",
            description: "base64 decoded content piped to shell",
            text: `${segments[i].command} | ${segments[i + 1].command}`,
          });
        }
      }
    }
  }

  function walkForPatterns(n: TSNode): void {
    if (n.type === "process_substitution") {
      patterns.push({
        type: "process_substitution",
        description: "Process substitution detected",
        text: n.text,
      });
    }

    if (n.type === "file_redirect") {
      const dest = n.lastChild;
      if (dest) {
        const destText = dest.text;
        for (const prefix of SENSITIVE_PATH_PREFIXES) {
          if (
            destText.startsWith(prefix) ||
            destText.startsWith(prefix.replace("~", "$HOME"))
          ) {
            patterns.push({
              type: "sensitive_redirect",
              description: `Redirect to sensitive path: ${destText}`,
              text: n.text,
            });
            break;
          }
        }
      }
    }

    if (n.type === "command_substitution" && n.parent) {
      const parent = n.parent;
      if (parent.type === "command") {
        const firstWord = parent.namedChild(0);
        if (
          firstWord &&
          (firstWord.text === "rm" ||
            firstWord.text === "chmod" ||
            firstWord.text === "chown")
        ) {
          patterns.push({
            type: "dangerous_substitution",
            description: `Command substitution as argument to ${firstWord.text}`,
            text: parent.text,
          });
        }
      }
    }

    if (n.type === "variable_assignment") {
      const varName = n.firstChild;
      if (varName && varName.type === "variable_name") {
        if (DANGEROUS_ENV_VARS.has(varName.text)) {
          patterns.push({
            type: "env_injection",
            description: `Assignment to dangerous env var: ${varName.text}`,
            text: n.text,
          });
        }
      }
    }

    for (const child of n.children) {
      walkForPatterns(child);
    }
  }

  walkForPatterns(node);
  return patterns;
}

function detectOpaqueConstructs(
  node: TSNode,
  segments: CommandSegment[],
): boolean {
  // Check segments for opaque programs
  for (const seg of segments) {
    if (OPAQUE_PROGRAMS.has(seg.program) || seg.program === ".") {
      return true;
    }
    if (
      SHELL_PROGRAMS.has(seg.program) &&
      (seg.args.includes("-c") || seg.args.includes("-ec"))
    ) {
      return true;
    }
  }

  function walkForOpacity(n: TSNode): boolean {
    // Heredocs / herestrings
    if (
      n.type === "heredoc_redirect" ||
      n.type === "heredoc_body" ||
      n.type === "herestring_redirect"
    ) {
      return true;
    }

    // Variable expansion used as command name
    if (n.type === "command") {
      const firstChild = n.namedChild(0);
      if (firstChild) {
        // Direct expansion as command (e.g. in some grammars)
        if (
          firstChild.type === "simple_expansion" ||
          firstChild.type === "expansion" ||
          firstChild.type === "command_substitution"
        ) {
          return true;
        }
        // tree-sitter-bash wraps the command name in a command_name node,
        // so check inside it for variable/command substitution
        if (firstChild.type === "command_name") {
          const inner = firstChild.namedChild(0);
          if (
            inner &&
            (inner.type === "simple_expansion" ||
              inner.type === "expansion" ||
              inner.type === "command_substitution" ||
              inner.type === "concatenation")
          ) {
            return true;
          }
        }
      }
    }

    // Hex/octal escape sequences in command position
    if (n.type === "ansi_c_string" || n.type === "ansii_c_string") {
      if (n.parent?.type === "command") {
        const first = n.parent.namedChild(0);
        if (first && first.equals(n)) {
          return true;
        }
      }
      if (/\\x[0-9a-fA-F]{2}|\\[0-7]{3}/.test(n.text)) {
        return true;
      }
    }

    // Array expansion as command
    if (
      n.type === "expansion" &&
      n.text.includes("[@]") &&
      n.parent?.type === "command"
    ) {
      const first = n.parent.namedChild(0);
      if (first && first.equals(n)) {
        return true;
      }
    }

    for (const child of n.children) {
      if (walkForOpacity(child)) return true;
    }
    return false;
  }

  return walkForOpacity(node);
}

export async function parse(command: string): Promise<ParsedCommand> {
  const parser = await ensureParser();
  const tree = parser.parse(command);
  if (!tree) {
    // Parser couldn't parse - treat as opaque
    return { segments: [], dangerousPatterns: [], hasOpaqueConstructs: true };
  }
  const rootNode = tree.rootNode;

  const segments = extractSegments(rootNode);
  const dangerousPatterns = detectDangerousPatterns(rootNode, segments);
  const hasOpaqueConstructs = detectOpaqueConstructs(rootNode, segments);

  tree.delete();

  return { segments, dangerousPatterns, hasOpaqueConstructs };
}

export { ensureParser };
