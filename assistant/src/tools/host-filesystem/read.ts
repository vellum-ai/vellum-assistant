import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { RiskLevel } from '../../permissions/types.js';
import type { Tool, ToolContext, ToolExecutionResult } from '../types.js';
import type { ToolDefinition } from '../../providers/types.js';
import { checkFileSizeOnDisk } from '../filesystem/size-guard.js';

class HostFileReadTool implements Tool {
  name = 'host_file_read';
  description = 'Read the contents of a file on the host filesystem';
  category = 'host-filesystem';
  defaultRiskLevel = RiskLevel.Medium;

  getDefinition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Absolute path to the host file to read',
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

  async execute(input: Record<string, unknown>, _context: ToolContext): Promise<ToolExecutionResult> {
    const rawPath = input.path as string;
    if (!rawPath || typeof rawPath !== 'string') {
      return { content: 'Error: path is required and must be a string', isError: true };
    }

    if (!isAbsolute(rawPath)) {
      return { content: `Error: path must be absolute for host file access: ${rawPath}`, isError: true };
    }
    const filePath = rawPath;

    if (!existsSync(filePath)) {
      return { content: `Error: File not found: ${filePath}`, isError: true };
    }

    const stat = statSync(filePath);
    if (stat.isDirectory()) {
      return { content: `Error: ${filePath} is a directory, not a file`, isError: true };
    }

    const sizeError = checkFileSizeOnDisk(filePath);
    if (sizeError) {
      return { content: `Error: ${sizeError}`, isError: true };
    }

    try {
      const content = readFileSync(filePath, 'utf-8');
      const lines = content.split('\n');

      const offset = (typeof input.offset === 'number' ? input.offset : 1) - 1;
      const limit = typeof input.limit === 'number' ? input.limit : lines.length;
      const selectedLines = lines.slice(Math.max(0, offset), offset + limit);

      const numbered = selectedLines.map((line, i) => {
        const lineNum = offset + i + 1;
        return `${String(lineNum).padStart(6)}  ${line}`;
      }).join('\n');

      return { content: numbered, isError: false };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const hint = msg.includes('ENOENT') ? ' (file does not exist)'
        : msg.includes('EACCES') ? ' (permission denied)'
        : msg.includes('EISDIR') ? ' (path is a directory, not a file)'
        : '';
      return { content: `Error reading file "${input.path}"${hint}: ${msg}`, isError: true };
    }
  }
}

export const hostFileReadTool: Tool = new HostFileReadTool();
