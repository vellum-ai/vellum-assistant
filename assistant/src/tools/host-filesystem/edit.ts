import { isAbsolute } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { RiskLevel } from '../../permissions/types.js';
import type { Tool, ToolContext, ToolExecutionResult } from '../types.js';
import type { ToolDefinition } from '../../providers/types.js';
import { checkFileSizeOnDisk } from '../filesystem/size-guard.js';
import { applyEdit } from '../shared/filesystem/edit-engine.js';

class HostFileEditTool implements Tool {
  name = 'host_file_edit';
  description = 'Replace exact text in a host filesystem file with new text';
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
            description: 'Absolute host path to the file to edit',
          },
          old_string: {
            type: 'string',
            description: 'The exact text to find in the file',
          },
          new_string: {
            type: 'string',
            description: 'The replacement text',
          },
          replace_all: {
            type: 'boolean',
            description: 'Replace all occurrences instead of requiring a unique match (default: false)',
          },
        },
        required: ['path', 'old_string', 'new_string'],
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

    const oldString = input.old_string;
    if (typeof oldString !== 'string') {
      return { content: 'Error: old_string is required and must be a string', isError: true };
    }

    const newString = input.new_string;
    if (typeof newString !== 'string') {
      return { content: 'Error: new_string is required and must be a string', isError: true };
    }

    if (oldString.length === 0) {
      return { content: 'Error: old_string must not be empty', isError: true };
    }

    if (oldString === newString) {
      return { content: 'Error: old_string and new_string must be different', isError: true };
    }

    try {
      const sizeError = checkFileSizeOnDisk(filePath);
      if (sizeError) {
        return { content: `Error: ${sizeError}`, isError: true };
      }
    } catch {
      // The subsequent file read returns a clearer error for missing files.
    }

    try {
      const content = readFileSync(filePath, 'utf-8');
      const replaceAll = input.replace_all === true;

      const result = applyEdit({ content, oldString, newString, replaceAll });
      if (!result.ok) {
        if (result.reason === 'not_found') {
          return { content: `Error: old_string not found in ${filePath}`, isError: true };
        }
        return {
          content: `Error: old_string appears multiple times in ${filePath}. Provide more surrounding context to make it unique, or set replace_all to true.`,
          isError: true,
        };
      }

      writeFileSync(filePath, result.updatedContent);

      if (replaceAll) {
        return {
          content: `Successfully replaced ${result.matchCount} occurrence${result.matchCount > 1 ? 's' : ''} in ${filePath}`,
          isError: false,
          diff: { filePath, oldContent: content, newContent: result.updatedContent, isNewFile: false },
        };
      }

      const methodNote = result.matchMethod === 'exact'
        ? ''
        : result.matchMethod === 'whitespace'
          ? ' (matched with whitespace normalization)'
          : ' (fuzzy matched)';

      return {
        content: `Successfully edited ${filePath}${methodNote}`,
        isError: false,
        diff: { filePath, oldContent: content, newContent: result.updatedContent, isNewFile: false },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: `Error editing file: ${msg}`, isError: true };
    }
  }
}

export const hostFileEditTool: Tool = new HostFileEditTool();
