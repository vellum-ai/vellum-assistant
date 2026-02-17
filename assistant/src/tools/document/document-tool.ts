import { RiskLevel } from '../../permissions/types.js';
import type { Tool, ToolContext, ToolExecutionResult } from '../types.js';
import type { ToolDefinition } from '../../providers/types.js';
import * as appStore from '../../memory/app-store.js';
import { randomUUID } from 'node:crypto';
import { generateEditorHTML } from './editor-template.js';

// ── document_create ──────────────────────────────────────────────────

export class DocumentCreateTool implements Tool {
  name = 'document_create';
  description =
    'Create a new long-form document with a rich text editor. Use this when the user asks to write a blog post, article, or any long-form content. The editor opens in workspace mode with chat docked to the side.';
  category = 'document';
  defaultRiskLevel = RiskLevel.Low;
  executionMode: 'local' = 'local';

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
    const title = (input.title as string | undefined) || 'Untitled Document';
    const initialContent = (input.initial_content as string | undefined) || '';
    const appId = `doc-${randomUUID()}`;

    // Generate the Toast UI Editor HTML
    const html = generateEditorHTML(title, initialContent);

    // Create the document app in the app store
    const wordCount = initialContent.split(/\s+/).filter((w) => w.length > 0).length;
    const app = appStore.createApp({
      name: title,
      description: `Document with ${wordCount} words`,
      icon: '📝',
      preview: initialContent.slice(0, 200),
      htmlDefinition: html,
      schemaJson: JSON.stringify({
        type: 'object',
        properties: {
          title: { type: 'string' },
          content: { type: 'string' },
          wordCount: { type: 'number' },
          documentType: { type: 'string', const: 'document' },
        },
      }),
      appType: 'app',
    });

    // Open the document via the proxy resolver if available
    if (context.proxyToolResolver) {
      try {
        const openResult = await context.proxyToolResolver('app_open', {
          app_id: app.id,
          preview: {
            title,
            subtitle: 'Document',
            description: 'Long-form document with rich text editor',
            icon: '📝',
            metrics: [{ label: 'Words', value: String(wordCount) }],
          },
        });

        return {
          content: JSON.stringify({
            app_id: appId,
            surface_id: app.id, // For now, use app ID as surface ID
            title,
            opened: true,
            open_result: openResult.content,
          }),
          isError: false,
        };
      } catch (err) {
        return {
          content: JSON.stringify({
            app_id: appId,
            title,
            opened: false,
            error: 'Failed to open document editor',
          }),
          isError: false,
        };
      }
    }

    return {
      content: JSON.stringify({
        app_id: appId,
        title,
        message: 'Document created but could not be opened (no proxy resolver available)',
      }),
      isError: false,
    };
  }
}

// ── document_update ──────────────────────────────────────────────────

export class DocumentUpdateTool implements Tool {
  name = 'document_update';
  description =
    'Update content in an open document editor. Use this to stream generated content or apply edits.';
  category = 'document';
  defaultRiskLevel = RiskLevel.Low;
  executionMode: 'local' = 'local';

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
    const surfaceId = input.surface_id as string;
    const content = input.content as string;
    const mode = (input.mode as string | undefined) || 'append';

    // Use the proxy resolver to call ui_update
    if (context.proxyToolResolver) {
      try {
        const updateResult = await context.proxyToolResolver('ui_update', {
          surface_id: surfaceId,
          data: {
            markdown: content,
            updateMode: mode,
          },
        });

        return {
          content: JSON.stringify({
            success: true,
            surface_id: surfaceId,
            mode,
            update_result: updateResult.content,
          }),
          isError: false,
        };
      } catch (err) {
        return {
          content: JSON.stringify({
            success: false,
            error: 'Failed to update document content',
            details: err instanceof Error ? err.message : String(err),
          }),
          isError: true,
        };
      }
    }

    return {
      content: JSON.stringify({
        success: false,
        error: 'No proxy resolver available to update document',
      }),
      isError: true,
    };
  }
}

// ── Exported tool instances ──────────────────────────────────────────

export const documentCreateTool = new DocumentCreateTool();
export const documentUpdateTool = new DocumentUpdateTool();
