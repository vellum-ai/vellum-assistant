import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { RiskLevel } from '../../permissions/types.js';
import type { Tool, ToolContext, ToolExecutionResult } from '../types.js';
import type { ToolDefinition } from '../../providers/types.js';
import { registerTool } from '../registry.js';
import { getConfig } from '../../config/loader.js';
import { getLogger } from '../../util/logger.js';
import { wrapCommand } from './sandbox.js';
import { buildSanitizedEnv } from './safe-env.js';

const log = getLogger('evaluate-typescript');

const MAX_CODE_BYTES = 100_000;
const MAX_MOCK_INPUT_BYTES = 100_000;
const DEFAULT_MAX_OUTPUT_CHARS = 25_000;
const DEFAULT_TIMEOUT_SEC = 10;
const MIN_TIMEOUT_SEC = 1;
const MAX_TIMEOUT_SEC = 20;

interface EvalResult {
  ok: boolean;
  exitCode: number | null;
  durationMs: number;
  result?: unknown;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timeout: boolean;
}

function sanitizeFilename(raw: string): string {
  const base = basename(raw).replace(/[^a-zA-Z0-9._-]/g, '_');
  if (!base || base.startsWith('.')) return 'snippet.ts';
  if (!base.endsWith('.ts')) return base + '.ts';
  return base;
}

function buildWrapperSource(snippetFilename: string, entrypoint: string): string {
  const exportName = entrypoint === 'run' ? 'run' : 'default';
  return `
import * as mod from './${snippetFilename}';

const fn = (mod as any)['${exportName}'];
if (typeof fn !== 'function') {
  console.error(JSON.stringify({ __eval_error: 'Snippet must export a function named "${exportName}"' }));
  process.exit(1);
}

const inputJson = process.env.__EVAL_INPUT_JSON ?? '{}';
let input: unknown;
try {
  input = JSON.parse(inputJson);
} catch {
  console.error(JSON.stringify({ __eval_error: 'Invalid JSON in __EVAL_INPUT_JSON' }));
  process.exit(1);
}

try {
  const result = await fn(input);
  console.log(JSON.stringify({ __eval_result: result }));
} catch (err: any) {
  console.error(err?.stack ?? String(err));
  process.exit(1);
}
`;
}

export class EvaluateTypescriptTool implements Tool {
  name = 'evaluate_typescript_code';
  description = 'Evaluate a TypeScript snippet in an isolated sandbox. Use this to test code before persisting it as a managed skill.';
  category = 'terminal';
  defaultRiskLevel = RiskLevel.High;

  getDefinition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: 'object',
        properties: {
          code: {
            type: 'string',
            description: 'The TypeScript source code to evaluate. Must export a `default` or `run` function with signature `(input: unknown) => unknown | Promise<unknown>`.',
          },
          mock_input_json: {
            type: 'string',
            description: 'Optional JSON string to pass as the input argument to the exported function. Defaults to "{}".',
          },
          timeout_seconds: {
            type: 'number',
            description: `Optional timeout in seconds (${MIN_TIMEOUT_SEC}-${MAX_TIMEOUT_SEC}). Defaults to ${DEFAULT_TIMEOUT_SEC}.`,
          },
          filename: {
            type: 'string',
            description: 'Optional filename for the snippet (default: "snippet.ts"). Sanitized to basename only.',
          },
          entrypoint: {
            type: 'string',
            enum: ['default', 'run'],
            description: 'Which export to call: "default" or "run". Defaults to "default".',
          },
          max_output_chars: {
            type: 'number',
            description: `Optional max output characters (1-${DEFAULT_MAX_OUTPUT_CHARS}). Defaults to ${DEFAULT_MAX_OUTPUT_CHARS}.`,
          },
        },
        required: ['code'],
      },
    };
  }

  async execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolExecutionResult> {
    const code = input.code;
    if (typeof code !== 'string' || !code.trim()) {
      return { content: 'Error: code is required and must be a non-empty string', isError: true };
    }
    if (Buffer.byteLength(code) > MAX_CODE_BYTES) {
      return { content: `Error: code exceeds maximum size of ${MAX_CODE_BYTES} bytes`, isError: true };
    }

    const mockInputJson = typeof input.mock_input_json === 'string' ? input.mock_input_json : '{}';
    if (Buffer.byteLength(mockInputJson) > MAX_MOCK_INPUT_BYTES) {
      return { content: `Error: mock_input_json exceeds maximum size of ${MAX_MOCK_INPUT_BYTES} bytes`, isError: true };
    }
    try {
      JSON.parse(mockInputJson);
    } catch {
      return { content: 'Error: mock_input_json must be valid JSON', isError: true };
    }

    const rawTimeout = typeof input.timeout_seconds === 'number' ? input.timeout_seconds : DEFAULT_TIMEOUT_SEC;
    const timeoutSec = Math.max(MIN_TIMEOUT_SEC, Math.min(MAX_TIMEOUT_SEC, Math.round(rawTimeout)));
    const timeoutMs = timeoutSec * 1000;

    const filename = sanitizeFilename(typeof input.filename === 'string' ? input.filename : 'snippet.ts');
    const entrypoint = input.entrypoint === 'run' ? 'run' : 'default';
    const maxOutputChars = typeof input.max_output_chars === 'number'
      ? Math.max(1, Math.min(DEFAULT_MAX_OUTPUT_CHARS, Math.round(input.max_output_chars)))
      : DEFAULT_MAX_OUTPUT_CHARS;

    const evalDir = join(context.workingDir, '.vellum-eval', randomUUID());

    try {
      mkdirSync(evalDir, { recursive: true });
      writeFileSync(join(evalDir, filename), code, 'utf-8');
      writeFileSync(join(evalDir, '__runner.ts'), buildWrapperSource(filename, entrypoint), 'utf-8');

      const result = await this.runSnippet(evalDir, mockInputJson, timeoutSec, timeoutMs, maxOutputChars, context);
      return { content: JSON.stringify(result), isError: !result.ok };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err }, 'evaluate_typescript_code failed');
      return { content: `Error: ${msg}`, isError: true };
    } finally {
      try {
        rmSync(evalDir, { recursive: true, force: true });
      } catch {
        // best effort
      }
    }
  }

  private runSnippet(
    evalDir: string,
    mockInputJson: string,
    timeoutSec: number,
    timeoutMs: number,
    maxOutputChars: number,
    _context: ToolContext,
  ): Promise<EvalResult> {
    return new Promise<EvalResult>((resolve) => {
      const startTime = Date.now();
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let timedOut = false;

      const config = getConfig();
      // Force sandbox on regardless of global config
      const sandboxConfig = { ...config.sandbox, enabled: true };
      const bunRunCmd = `bun run __runner.ts`;
      const wrapped = wrapCommand(bunRunCmd, evalDir, sandboxConfig);

      const env = buildSanitizedEnv();
      env.__EVAL_INPUT_JSON = mockInputJson;

      const child = spawn(wrapped.command, wrapped.args, {
        cwd: evalDir,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeoutMs);

      child.stdout.on('data', (data: Buffer) => stdoutChunks.push(data));
      child.stderr.on('data', (data: Buffer) => stderrChunks.push(data));

      child.on('close', (code) => {
        clearTimeout(timer);
        const durationMs = Date.now() - startTime;

        let stdout = Buffer.concat(stdoutChunks).toString();
        let stderr = Buffer.concat(stderrChunks).toString();
        let truncated = false;

        if (stdout.length + stderr.length > maxOutputChars) {
          truncated = true;
          const halfMax = Math.floor(maxOutputChars / 2);
          if (stdout.length > halfMax) stdout = stdout.slice(0, halfMax) + '\n[stdout truncated]';
          if (stderr.length > halfMax) stderr = stderr.slice(0, halfMax) + '\n[stderr truncated]';
        }

        // Extract structured result from stdout
        let result: unknown = undefined;
        if (code === 0) {
          const lines = stdout.split('\n');
          for (const line of lines) {
            try {
              const parsed = JSON.parse(line);
              if (parsed && typeof parsed === 'object' && '__eval_result' in parsed) {
                result = parsed.__eval_result;
                break;
              }
            } catch {
              // not the result line
            }
          }
        }

        resolve({
          ok: code === 0 && !timedOut,
          exitCode: code,
          durationMs,
          result,
          stdout,
          stderr,
          truncated,
          timeout: timedOut,
        });
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        const durationMs = Date.now() - startTime;
        resolve({
          ok: false,
          exitCode: null,
          durationMs,
          stdout: '',
          stderr: `Error spawning process: ${err.message}`,
          truncated: false,
          timeout: false,
        });
      });
    });
  }
}

export const evaluateTypescriptTool: Tool = new EvaluateTypescriptTool();
registerTool(evaluateTypescriptTool);
