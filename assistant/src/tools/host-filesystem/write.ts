import { dirname, isAbsolute } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { RiskLevel } from '../../permissions/types.js';
import type { Tool, ToolContext, ToolExecutionResult } from '../types.js';
import type { ToolDefinition } from '../../providers/types.js';
import { checkContentSize } from '../filesystem/size-guard.js';

class HostFileWriteTool implements Tool {
  name = 'host_file_write';
  description = 'Write content to a file on the host filesystem, creating it if it does not exist';
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
            description: 'Absolute host path to the file to write',
          },
          content: {
            type: 'string',
            description: 'The content to write to the file',
          },
        },
        required: ['path', 'content'],
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

    const fileContent = input.content;
    if (typeof fileContent !== 'string') {
      return { content: 'Error: content is required and must be a string', isError: true };
    }

    const sizeError = checkContentSize(fileContent, filePath);
    if (sizeError) {
      return { content: `Error: ${sizeError}`, isError: true };
    }

    try {
      const dir = dirname(filePath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      let oldContent: string | null = null;
      const isNewFile = !existsSync(filePath);
      if (!isNewFile) {
        try {
          oldContent = readFileSync(filePath, 'utf-8');
        } catch {
          // Keep oldContent null when host file is unreadable.
        }
      }

      writeFileSync(filePath, fileContent);
      return {
        content: `Successfully wrote to ${filePath}`,
        isError: false,
        diff: { filePath, oldContent: oldContent ?? '', newContent: fileContent, isNewFile },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const hint = msg.includes('ENOENT') ? ' (parent directory does not exist)'
        : msg.includes('EACCES') ? ' (permission denied)'
        : msg.includes('EROFS') ? ' (read-only file system)'
        : '';
      return { content: `Error writing file "${input.path}"${hint}: ${msg}`, isError: true };
    }
  }
}

export const hostFileWriteTool: Tool = new HostFileWriteTool();
