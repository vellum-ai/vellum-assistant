import { RiskLevel } from '../../permissions/types.js';
import type { Tool, ToolContext, ToolExecutionResult } from '../types.js';
import type { ToolDefinition } from '../../providers/types.js';
import { randomUUID } from 'node:crypto';

// ── Exported execute functions ──────────────────────────────────────

export function executeDocumentCreate(input: Record<string, unknown>, context: ToolContext): ToolExecutionResult {
  const title = (input.title as string | undefined) || 'Untitled Document';
  const initialContent = (input.initial_content as string | undefined) || '';
  const surfaceId = `doc-${randomUUID()}`;

  // Send document_editor_show IPC message to open the built-in RTE
  if (context.sendToClient) {
    context.sendToClient({
      type: 'document_editor_show',
      sessionId: context.sessionId,
      surfaceId,
      title,
      initialContent,
    });

    context.sendToClient({
      type: 'ui_surface_show',
      sessionId: context.sessionId,
      surfaceId: `preview-${surfaceId}`,
      surfaceType: 'document_preview',
      display: 'inline',
      title,
      data: {
        title,
        surfaceId,
        subtitle: 'Document',
      },
    });

    return {
      content: JSON.stringify({
        surface_id: surfaceId,
        title,
        opened: true,
        message: 'Document editor opened in Directory panel',
      }),
      isError: false,
    };
  }

  // Fallback if no IPC client is connected
  return {
    content: JSON.stringify({
      surface_id: surfaceId,
      title,
      opened: false,
      error: 'No IPC client connected to open document editor',
    }),
    isError: false,
  };
}

export function executeDocumentUpdate(input: Record<string, unknown>, context: ToolContext): ToolExecutionResult {
  const surfaceId = input.surface_id as string;
  const content = input.content as string;
  const mode = (input.mode as string | undefined) || 'append';

  // Send document_editor_update IPC message to update the built-in RTE
  if (context.sendToClient) {
    context.sendToClient({
      type: 'document_editor_update',
      sessionId: context.sessionId,
      surfaceId,
      markdown: content,
      mode,
    });

    return {
      content: JSON.stringify({
        success: true,
        surface_id: surfaceId,
        mode,
        message: 'Document content updated',
      }),
      isError: false,
    };
  }

  // Fallback if no IPC client is connected
  return {
    content: JSON.stringify({
      success: false,
      error: 'No IPC client connected to update document',
    }),
    isError: true,
  };
}

// ── document_create ──────────────────────────────────────────────────

export class DocumentCreateTool implements Tool {
  name = 'document_create';
  description =
    'Create a new long-form document with a rich text editor. Use this when the user asks to write a blog post, article, or any long-form content. The editor opens in workspace mode with chat docked to the side.';
  category = 'document';
  defaultRiskLevel = RiskLevel.Low;
  executionMode = 'local' as const;

  getDefinition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: 'object',
        properties: {
          title: {
            type: 'string',
            description: 'Initial title for the document (optional, can be updated later)',
          },
          initial_content: {
            type: 'string',
            description: 'Initial Markdown content to populate the editor (optional)',
          },
        },
      },
    };
  }

  async execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolExecutionResult> {
    return executeDocumentCreate(input, context);
  }
}

// ── document_update ──────────────────────────────────────────────────

export class DocumentUpdateTool implements Tool {
  name = 'document_update';
  description =
    'Update content in an open document editor. Use this to stream generated content or apply edits.';
  category = 'document';
  defaultRiskLevel = RiskLevel.Low;
  executionMode = 'local' as const;

  getDefinition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: 'object',
        properties: {
          surface_id: {
            type: 'string',
            description: 'The ID of the document surface to update',
          },
          content: {
            type: 'string',
            description: 'Markdown content to set or append',
          },
          mode: {
            type: 'string',
            enum: ['replace', 'append'],
            description: 'Whether to replace all content or append to the end. Defaults to append.',
          },
        },
        required: ['surface_id', 'content'],
      },
    };
  }

  async execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolExecutionResult> {
    return executeDocumentUpdate(input, context);
  }
}

// ── Exported tool instances ──────────────────────────────────────────

export const documentCreateTool = new DocumentCreateTool();
export const documentUpdateTool = new DocumentUpdateTool();
