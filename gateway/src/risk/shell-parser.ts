import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { Language, type Node as TSNode, Parser } from "web-tree-sitter";

import { getLogger } from "../logger.js";

import type { DangerousPattern, DangerousPatternType } from "./risk-types.js";

const log = getLogger("shell-parser");

// ── Inline helpers (self-contained, no assistant imports) ────────────────────

class IntegrityError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "IntegrityError";
  }
}

/**
 * Guards against concurrent execution of an async factory.
 * Multiple concurrent callers share the same in-flight promise.
 * On failure, the guard resets so subsequent calls can retry.
 */
class PromiseGuard<T> {
  private promise: Promise<T> | null = null;

  run(factory: () => Promise<T>, onError?: (err: unknown) => void): Promise<T> {
    if (this.promise) return this.promise;

    this.promise = factory();
    this.promise.catch((err) => {
      this.promise = null;
      onError?.(err);
    });
    return this.promise;
  }
}

// ── Re-export types for consumers ────────────────────────────────────────────

export type { DangerousPattern, DangerousPatternType };

export interface CommandSegment {
  command: string;
  program: string;
  args: string[];
  operator: "&&" | "||" | ";" | "|" | "";
  /**
   * `true` when this segment did not originate from a top-level pipeline
   * member that the user typed directly. Set in two cases:
   *
   * 1. **Nested context** — the segment was extracted from inside a
   *    subshell, command substitution, or other compound construct
   *    (`(...)`, `$(...)`, `{ ... }`, `if`/`while`/`for`/`case` blocks).
   * 2. **Parse-error recovery** — tree-sitter could not parse the
   *    user-typed expression and recovered by splitting it into multiple
   *    sibling top-level statements with no actual list separator
   *    (`;`, newline, `&&`, `||`) between them in the source text. The
   *    canonical trigger is unquoted parens or brackets in a path
   *    argument, e.g. `cat /a/(b)/c.txt | grep d`, which tree-sitter
   *    decomposes into `cat /a/`, `(b)`, and `/c.txt | grep d`.
   *
   * Risk classification still considers synthetic segments (so dangers
   * inside subshells are caught), but consumers that present commands
   * back to the user — like the trust-rule editor's "Apply to" wildcard
   * list — should filter them out, since their `program` names don't
   * correspond to commands the user actually intended to run.
   */
  synthetic?: boolean;
}

export interface ParsedCommand {
  /**
   * The literal command string that was parsed. Preserved verbatim so
   * downstream consumers (scope option generation, allowlist UIs) can
   * present the original text the user typed instead of attempting to
   * reconstruct it from segments — segment reconstruction loses
   * separator characters like `;` and is unreliable for parse-recovery
   * cases where unquoted parens/brackets in path arguments make
   * tree-sitter split a single command into multiple fragments.
   */
  originalCommand: string;
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
// Flags that make an interpreter read code from stdin rather than from a file.
const STDIN_EXEC_FLAGS = new Set(["-"]);
// Per-interpreter flags that provide code inline as an argument (e.g.
// `python -c 'code'`, `node -e 'code'`). When these are present the
// interpreter is NOT reading code from stdin — stdin is just data, so piping
// into the interpreter is no more dangerous than piping into grep or jq.
//
// This must be interpreter-specific because the same flag can mean different
// things across interpreters. For example, `perl -c` is syntax-check mode
// (still reads code from stdin and executes BEGIN blocks), while
// `python -c` provides inline code. Similarly, `ruby -c` is syntax-check.
const INTERPRETER_INLINE_CODE_FLAGS: ReadonlyMap<
  string,
  ReadonlySet<string>
> = new Map([
  ["python", new Set(["-c"])],
  ["python3", new Set(["-c"])],
  ["ruby", new Set(["-e"])],
  ["perl", new Set(["-e"])],
  ["node", new Set(["-e"])],
  ["deno", new Set(["-e"])],
  ["bun", new Set(["-e"])],
]);
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
 * In the gateway dev environment the file lives under `node_modules/`
 * relative to the source tree. `require.resolve()` is the primary
 * resolution strategy, with manual fallbacks for hoisted layouts.
 */
function findWasmPath(
  pkg: string,
  file: string,
  resolvedPkgDir?: string,
): string {
  const dir = import.meta.dirname ?? __dirname;

  // In compiled Bun binaries, import.meta.dirname points into the virtual
  // /$bunfs/ filesystem. Prefer bundled WASM assets shipped alongside the
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
    // Last resort: resolve from process.cwd()
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

  // Dynamic module resolution handles hoisted dependencies.
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

  const sourcePath = join(dir, "..", "..", "node_modules", pkg, file);

  if (existsSync(sourcePath)) return sourcePath;

  // Fallback: resolve from process.cwd().
  const cwdPath = join(process.cwd(), "node_modules", pkg, file);
  if (existsSync(cwdPath)) return cwdPath;

  return sourcePath;
}

export async function ensureParser(): Promise<Parser> {
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

/**
 * Source-text characters that, when present in the gap between two
 * consecutive top-level `program` children, indicate the user actually
 * typed a list/pipeline separator (so the second child is a real sibling
 * statement, not parse-error recovery).
 *
 * Includes `\r` for completeness on Windows-style line endings, even
 * though tree-sitter normally consumes them as part of `\n`.
 */
const LIST_SEPARATOR_CHARS_RE = /[;\n\r&|]/;

function extractSegments(node: TSNode, source: string): CommandSegment[] {
  const segments: CommandSegment[] = [];

  function emit(seg: CommandSegment, synthetic: boolean): void {
    if (synthetic) {
      segments.push({ ...seg, synthetic: true });
    } else {
      segments.push(seg);
    }
  }

  // `nestingDepth` counts how many subshell/command-substitution/compound
  // ancestors enclose the current node. A non-zero depth means any segment
  // emitted from this subtree is "synthetic" — extracted from a nested
  // context rather than a top-level pipeline member.
  //
  // `recoverySibling` is true when we are walking a `program` child that
  // sits next to a previous child with no list separator between them in
  // the source — i.e. tree-sitter parse-recovered a malformed expression
  // into multiple statements. The flag propagates to all descendants so
  // their emitted segments are also marked synthetic.
  function walkNode(
    n: TSNode,
    operator: CommandSegment["operator"],
    nestingDepth: number,
    recoverySibling: boolean,
  ): void {
    const synthetic = nestingDepth > 0 || recoverySibling;

    switch (n.type) {
      case "program": {
        // The `program` root has no enclosing context, so any list
        // separator the user typed appears in the literal source between
        // sibling statement children. If ANY pair of statement siblings
        // is missing a separator in the gap between them, tree-sitter
        // parse-recovered a single malformed command into fragments —
        // and ALL siblings (including the first) must be marked
        // synthetic, since they are pieces of a command the user didn't
        // intend to split.
        const statementChildren: TSNode[] = [];
        for (const child of n.namedChildren) {
          if (child.type === "comment") continue;
          statementChildren.push(child);
        }
        let isRecovery = recoverySibling;
        if (!isRecovery) {
          for (let i = 1; i < statementChildren.length; i++) {
            // web-tree-sitter exposes startIndex/endIndex as UTF-16
            // code-unit positions on the original source string (not
            // UTF-8 byte offsets like the C/Rust core). They line up
            // with `source.slice(...)` directly — verified by the
            // non-ASCII regression tests below.
            const gap = source.slice(
              statementChildren[i - 1].endIndex,
              statementChildren[i].startIndex,
            );
            if (!LIST_SEPARATOR_CHARS_RE.test(gap)) {
              isRecovery = true;
              break;
            }
          }
        }
        for (const child of statementChildren) {
          walkNode(child, "", nestingDepth, isRecovery);
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
            walkNode(child, operator, nestingDepth, recoverySibling);
            operator = "";
          }
        }
        break;
      }

      case "pipeline": {
        let first = true;
        for (const child of n.namedChildren) {
          walkNode(
            child,
            first ? operator : "|",
            nestingDepth,
            recoverySibling,
          );
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
          emit(
            {
              command: n.text,
              program: words[0],
              args: words.slice(1),
              operator,
            },
            synthetic,
          );
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
            walkNode(child, operator, nestingDepth, recoverySibling);
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
      case "function_definition": {
        // Descending into a nested execution context — bump depth so any
        // segments emitted from this subtree are marked synthetic.
        for (const child of n.namedChildren) {
          walkNode(child, operator, nestingDepth + 1, recoverySibling);
        }
        break;
      }

      case "negated_command": {
        // `! cmd` is a prefix operator that negates the pipeline's exit
        // status; it is NOT a nested execution context. The user still
        // typed the inner commands at the top level, so they must keep
        // their parent's nesting depth (otherwise `! ls` and similar
        // lose their `ls *` wildcard scope option in the trust-rule
        // editor).
        for (const child of n.namedChildren) {
          walkNode(child, operator, nestingDepth, recoverySibling);
        }
        break;
      }

      default: {
        for (const child of n.namedChildren) {
          walkNode(child, operator, nestingDepth, recoverySibling);
        }
        break;
      }
    }
  }

  walkNode(node, "", 0, false);
  return segments;
}

/**
 * Returns true when the interpreter args indicate stdin-exec mode - i.e. the
 * interpreter will read code from stdin rather than from a file.  Concretely:
 *   - Any STDIN_EXEC_FLAGS present → stdin-exec
 *   - Interpreter-specific inline code flag (-c/-e) → NOT stdin-exec
 *   - No positional (non-flag) arguments at all → stdin-exec (bare `python`)
 *   - Otherwise the first positional arg is a filename → NOT stdin-exec
 */
function isStdinExecMode(interpreter: string, args: string[]): boolean {
  const valueFlags =
    INTERPRETER_VALUE_FLAGS.get(interpreter) ?? new Set<string>();
  const inlineCodeFlags =
    INTERPRETER_INLINE_CODE_FLAGS.get(interpreter) ?? new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (STDIN_EXEC_FLAGS.has(arg)) return true;
    // Interpreter-specific inline code flags (e.g. python -c, node -e) mean
    // the code is provided as an argument, not read from stdin.
    if (inlineCodeFlags.has(arg)) return false;
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
    return {
      originalCommand: command,
      segments: [],
      dangerousPatterns: [],
      hasOpaqueConstructs: true,
    };
  }
  const rootNode = tree.rootNode;

  const segments = extractSegments(rootNode, command);
  const dangerousPatterns = detectDangerousPatterns(rootNode, segments);
  const hasOpaqueConstructs = detectOpaqueConstructs(rootNode, segments);

  tree.delete();

  return {
    originalCommand: command,
    segments,
    dangerousPatterns,
    hasOpaqueConstructs,
  };
}
