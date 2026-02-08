import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { RiskLevel } from '../../permissions/types.js';
import type { Tool, ToolContext, ToolExecutionResult } from '../types.js';
import type { ToolDefinition } from '../../providers/types.js';
import { registerTool } from '../registry.js';

class FileReadTool implements Tool {
  name = 'file_read';
  description = 'Read the contents of a file';
  category = 'filesystem';
  defaultRiskLevel = RiskLevel.Low;

  getDefinition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'The path to the file to read (absolute or relative to working directory)',
          },
          offset: {
            type: 'number',
            description: 'Line number to start reading from (1-indexed)',
          },
          limit: {
            type: 'number',
            description: 'Maximum number of lines to read',
          },
        },
        required: ['path'],
      },
    };
  }

  async execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolExecutionResult> {
    const rawPath = input.path as string;
    if (!rawPath || typeof rawPath !== 'string') {
      return { content: 'Error: path is required and must be a string', isError: true };
    }

    const filePath = resolve(context.workingDir, rawPath);

    if (!existsSync(filePath)) {
      return { content: `Error: File not found: ${filePath}`, isError: true };
    }

    const stat = statSync(filePath);
    if (stat.isDirectory()) {
      return { content: `Error: ${filePath} is a directory, not a file`, isError: true };
    }

    try {
      const content = readFileSync(filePath, 'utf-8');
      const lines = content.split('\n');

      const offset = (typeof input.offset === 'number' ? input.offset : 1) - 1; // Convert to 0-indexed
      const limit = typeof input.limit === 'number' ? input.limit : lines.length;
      const selectedLines = lines.slice(Math.max(0, offset), offset + limit);

      // Add line numbers
      const numbered = selectedLines.map((line, i) => {
        const lineNum = offset + i + 1;
        return `${String(lineNum).padStart(6)}  ${line}`;
      }).join('\n');

      return { content: numbered, isError: false };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: `Error reading file: ${msg}`, isError: true };
    }
  }
}

registerTool(new FileReadTool());
