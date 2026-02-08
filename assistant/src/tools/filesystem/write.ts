import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { RiskLevel } from '../../permissions/types.js';
import type { Tool, ToolContext, ToolExecutionResult } from '../types.js';
import type { ToolDefinition } from '../../providers/types.js';
import { registerTool } from '../registry.js';

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

    const filePath = resolve(context.workingDir, rawPath);

    try {
      // Create parent directories if needed
      const dir = dirname(filePath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      // Capture old content for diff (if file exists)
      let oldContent: string | null = null;
      if (existsSync(filePath)) {
        try { oldContent = readFileSync(filePath, 'utf-8'); } catch { /* new file */ }
      }

      writeFileSync(filePath, fileContent);
      return {
        content: `Successfully wrote to ${filePath}`,
        isError: false,
        diff: { filePath, oldContent: oldContent ?? '', newContent: fileContent },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: `Error writing file: ${msg}`, isError: true };
    }
  }
}

registerTool(new FileWriteTool());
