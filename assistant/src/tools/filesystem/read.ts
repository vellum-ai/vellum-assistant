import { RiskLevel } from '../../permissions/types.js';
import type { Tool, ToolContext, ToolExecutionResult } from '../types.js';
import type { ToolDefinition } from '../../providers/types.js';
import { registerTool } from '../registry.js';
import { FileSystemOps } from '../shared/filesystem/file-ops-service.js';
import { sandboxPolicy } from '../shared/filesystem/path-policy.js';

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

    const ops = new FileSystemOps((path, opts) => sandboxPolicy(path, context.workingDir, opts));
    const result = ops.readFileSafe({
      path: rawPath,
      offset: typeof input.offset === 'number' ? input.offset : undefined,
      limit: typeof input.limit === 'number' ? input.limit : undefined,
    });

    if (!result.ok) {
      const err = result.error;
      if (err.code === 'NOT_A_FILE') {
        return { content: `Error: ${err.path} is a directory, not a file`, isError: true };
      }
      return { content: `Error: ${err.message}`, isError: true };
    }

    return { content: result.value.content, isError: false };
  }
}

registerTool(new FileReadTool());
