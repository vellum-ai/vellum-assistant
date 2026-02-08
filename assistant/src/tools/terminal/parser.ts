import { join } from 'node:path';
import { getLogger } from '../../util/logger.js';
import { Parser, Language, type Node as TSNode } from 'web-tree-sitter';

const log = getLogger('shell-parser');

export type DangerousPatternType =
  | 'pipe_to_shell'
  | 'base64_execute'
  | 'process_substitution'
  | 'sensitive_redirect'
  | 'dangerous_substitution'
  | 'env_injection';

export interface DangerousPattern {
  type: DangerousPatternType;
  description: string;
  text: string;
}

export interface CommandSegment {
  command: string;
  program: string;
  args: string[];
  operator: '&&' | '||' | ';' | '|' | '';
}

export interface ParsedCommand {
  segments: CommandSegment[];
  dangerousPatterns: DangerousPattern[];
  hasOpaqueConstructs: boolean;
}

const SHELL_PROGRAMS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish']);
const OPAQUE_PROGRAMS = new Set(['eval', 'source']);
const DANGEROUS_ENV_VARS = new Set([
  'LD_PRELOAD', 'LD_LIBRARY_PATH',
  'DYLD_INSERT_LIBRARIES', 'DYLD_LIBRARY_PATH', 'DYLD_FRAMEWORK_PATH',
  'NODE_OPTIONS', 'NODE_PATH',
  'PATH', 'PYTHONPATH', 'RUBYLIB',
]);
const SENSITIVE_PATH_PREFIXES = [
  '~/.zshrc', '~/.bashrc', '~/.bash_profile', '~/.profile',
  '~/.ssh/', '~/.gnupg/', '~/.config/',
  '/etc/', '/usr/lib/', '/usr/bin/',
];

let parserInstance: Parser | null = null;
let initPromise: Promise<void> | null = null;

function findBashWasmPath(): string {
  // Resolve from node_modules relative to project root
  // import.meta.dirname points to src/tools/terminal/, so go up 3 levels
  const fromSource = join(
    import.meta.dirname ?? __dirname,
    '..', '..', '..', 'node_modules', 'tree-sitter-bash', 'tree-sitter-bash.wasm',
  );
  return fromSource;
}

async function ensureParser(): Promise<Parser> {
  if (parserInstance) return parserInstance;

  if (!initPromise) {
    initPromise = (async () => {
      // Let web-tree-sitter find its own WASM via import.meta.url
      await Parser.init();

      const bashWasmPath = findBashWasmPath();
      const Bash = await Language.load(bashWasmPath);
      const parser = new Parser();
      parser.setLanguage(Bash);
      parserInstance = parser;
      log.info('Shell parser initialized (web-tree-sitter + bash)');
    })();
  }

  await initPromise;
  return parserInstance!;
}

function extractSegments(node: TSNode): CommandSegment[] {
  const segments: CommandSegment[] = [];

  function walkNode(n: TSNode, operator: CommandSegment['operator']): void {
    switch (n.type) {
      case 'program': {
        for (const child of n.namedChildren) {
          walkNode(child, '');
        }
        break;
      }

      case 'list': {
        // list = command (operator command)*
        for (let i = 0; i < n.childCount; i++) {
          const child = n.child(i);
          if (!child) continue;
          if (child.type === '&&' || child.type === '||' || child.type === ';') {
            operator = child.type as CommandSegment['operator'];
          } else if (child.type !== 'comment') {
            walkNode(child, operator);
            operator = '';
          }
        }
        break;
      }

      case 'pipeline': {
        let first = true;
        for (const child of n.namedChildren) {
          walkNode(child, first ? operator : '|');
          first = false;
        }
        break;
      }

      case 'command': {
        const words: string[] = [];
        for (const child of n.namedChildren) {
          if (child.type === 'command_name' || child.type === 'word' ||
              child.type === 'string' || child.type === 'raw_string' ||
              child.type === 'simple_expansion' || child.type === 'expansion' ||
              child.type === 'command_substitution' || child.type === 'concatenation' ||
              child.type === 'number') {
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

      case 'redirected_statement': {
        for (const child of n.namedChildren) {
          if (child.type !== 'file_redirect' && child.type !== 'heredoc_redirect' &&
              child.type !== 'herestring_redirect') {
            walkNode(child, operator);
          }
        }
        break;
      }

      case 'subshell':
      case 'command_substitution':
      case 'compound_statement':
      case 'if_statement':
      case 'while_statement':
      case 'for_statement':
      case 'case_statement':
      case 'function_definition':
      case 'negated_command': {
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

  walkNode(node, '');
  return segments;
}

function detectDangerousPatterns(node: TSNode, segments: CommandSegment[]): DangerousPattern[] {
  const patterns: DangerousPattern[] = [];

  // Check pipeline ending in shell
  for (let i = 1; i < segments.length; i++) {
    if (segments[i].operator === '|') {
      const prog = segments[i].program;
      if (SHELL_PROGRAMS.has(prog) || prog === 'eval' || prog === 'xargs') {
        patterns.push({
          type: 'pipe_to_shell',
          description: `Pipeline into ${prog}`,
          text: segments[i].command,
        });
      }
    }
  }

  // Check base64 piped to shell
  for (let i = 0; i < segments.length - 1; i++) {
    if (segments[i].program === 'base64' && segments[i].args.includes('-d')) {
      if (i + 1 < segments.length && segments[i + 1].operator === '|') {
        const nextProg = segments[i + 1].program;
        if (SHELL_PROGRAMS.has(nextProg) || nextProg === 'eval') {
          patterns.push({
            type: 'base64_execute',
            description: 'base64 decoded content piped to shell',
            text: `${segments[i].command} | ${segments[i + 1].command}`,
          });
        }
      }
    }
  }

  // Walk AST for structural patterns
  function walkForPatterns(n: TSNode): void {
    // Process substitution
    if (n.type === 'process_substitution') {
      patterns.push({
        type: 'process_substitution',
        description: 'Process substitution detected',
        text: n.text,
      });
    }

    // Sensitive file redirects
    if (n.type === 'file_redirect') {
      const dest = n.lastChild;
      if (dest) {
        const destText = dest.text;
        for (const prefix of SENSITIVE_PATH_PREFIXES) {
          if (destText.startsWith(prefix) || destText.startsWith(prefix.replace('~', '$HOME'))) {
            patterns.push({
              type: 'sensitive_redirect',
              description: `Redirect to sensitive path: ${destText}`,
              text: n.text,
            });
            break;
          }
        }
      }
    }

    // Command substitution as arg to dangerous commands
    if (n.type === 'command_substitution' && n.parent) {
      const parent = n.parent;
      if (parent.type === 'command') {
        const firstWord = parent.namedChild(0);
        if (firstWord && (firstWord.text === 'rm' || firstWord.text === 'chmod' || firstWord.text === 'chown')) {
          patterns.push({
            type: 'dangerous_substitution',
            description: `Command substitution as argument to ${firstWord.text}`,
            text: parent.text,
          });
        }
      }
    }

    // Environment variable injection
    if (n.type === 'variable_assignment') {
      const varName = n.firstChild;
      if (varName && varName.type === 'variable_name') {
        if (DANGEROUS_ENV_VARS.has(varName.text)) {
          patterns.push({
            type: 'env_injection',
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

function detectOpaqueConstructs(node: TSNode, segments: CommandSegment[]): boolean {
  // Check segments for opaque programs
  for (const seg of segments) {
    if (OPAQUE_PROGRAMS.has(seg.program) || seg.program === '.') {
      return true;
    }
    if (SHELL_PROGRAMS.has(seg.program) && (seg.args.includes('-c') || seg.args.includes('-ec'))) {
      return true;
    }
  }

  // Walk AST for structural opacity
  function walkForOpacity(n: TSNode): boolean {
    // Heredocs / herestrings
    if (n.type === 'heredoc_redirect' || n.type === 'heredoc_body' ||
        n.type === 'herestring_redirect') {
      return true;
    }

    // Variable expansion used as command name
    if (n.type === 'command') {
      const firstChild = n.namedChild(0);
      if (firstChild && (
        firstChild.type === 'simple_expansion' ||
        firstChild.type === 'expansion' ||
        firstChild.type === 'command_substitution'
      )) {
        return true;
      }
    }

    // Hex/octal escape sequences in command position
    if (n.type === 'ansi_c_string' || n.type === 'ansii_c_string') {
      if (n.parent?.type === 'command') {
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
    if (n.type === 'expansion' && n.text.includes('[@]') && n.parent?.type === 'command') {
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
    // Parser couldn't parse — treat as opaque
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
