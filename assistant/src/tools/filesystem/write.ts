import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { RiskLevel } from '../../permissions/types.js';
import type { Tool, ToolContext, ToolExecutionResult } from '../types.js';
import type { ToolDefinition } from '../../providers/types.js';
import { registerTool } from '../registry.js';
import { validateFilePath } from './path-guard.js';
import { checkContentSize } from './size-guard.js';

class FileWriteTool implements Tool {
  name = 'file_write';
  description = 'Write content to a file, creating it if it does not exist';
  category = 'filesystem';
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
            description: 'The path to the file to write (absolute or relative to working directory)',
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

  async execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolExecutionResult> {
    const rawPath = input.path as string;
    if (!rawPath || typeof rawPath !== 'string') {
      return { content: 'Error: path is required and must be a string', isError: true };
    }

    const fileContent = input.content;
    if (typeof fileContent !== 'string') {
      return { content: 'Error: content is required and must be a string', isError: true };
    }

    const pathCheck = validateFilePath(rawPath, context.workingDir, { mustExist: false });
    if (!pathCheck.ok) {
      return { content: `Error: ${pathCheck.error}`, isError: true };
    }
    const filePath = pathCheck.resolved;

    const sizeError = checkContentSize(fileContent, filePath);
    if (sizeError) {
      return { content: `Error: ${sizeError}`, isError: true };
    }

    try {
      // Create parent directories if needed
      const dir = dirname(filePath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      // Capture old content for diff (if file exists)
      let oldContent: string | null = null;
      const isNewFile = !existsSync(filePath);
      if (!isNewFile) {
        try { oldContent = readFileSync(filePath, 'utf-8'); } catch { /* unreadable */ }
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

registerTool(new FileWriteTool());
