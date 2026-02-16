/**
 * Gmail tool definitions.
 *
 * Each tool definition includes its JSON schema for input parameters.
 * Executors are wired in a separate file (executors.ts).
 *
 * Risk levels:
 * - Low: read-only or low-impact actions (auto-allowed)
 * - Medium: modifying actions, require confidence score input
 *
 * Medium-risk tools include a `confidence` parameter (0-1 float) that the
 * LLM self-reports to indicate how certain it is about the action.
 */

import type { ToolDefinition } from '../../providers/types.js';
import { RiskLevel } from '../../permissions/types.js';

interface GmailToolMeta {
  definition: ToolDefinition;
  riskLevel: RiskLevel;
  category: string;
}

// ── Low-risk tools (read-only) ──────────────────────────────────────

export const gmailSearchDef: GmailToolMeta = {
  category: 'gmail',
  riskLevel: RiskLevel.Low,
  definition: {
    name: 'gmail_search',
    description: 'Search emails using Gmail search syntax. Returns message IDs and metadata.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Gmail search query (e.g. "from:user@example.com newer_than:7d")' },
        max_results: { type: 'number', description: 'Maximum number of results to return (default 20, max 200)' },
        format: { type: 'string', enum: ['minimal', 'metadata', 'full'], description: 'Message format to return (default "metadata")' },
        metadata_headers: {
          type: 'array',
          items: { type: 'string' },
          description: 'Headers to include when format is "metadata" (e.g. ["From", "Subject", "List-Unsubscribe"])',
        },
      },
      required: ['query'],
    },
  },
};

export const gmailListMessagesDef: GmailToolMeta = {
  category: 'gmail',
  riskLevel: RiskLevel.Low,
  definition: {
    name: 'gmail_list_messages',
    description: 'List recent messages from the inbox. Returns message IDs and metadata.',
    input_schema: {
      type: 'object',
      properties: {
        max_results: { type: 'number', description: 'Maximum number of results (default 20, max 200)' },
        label_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Filter by label IDs (e.g. ["INBOX", "UNREAD"])',
        },
        page_token: { type: 'string', description: 'Token for the next page of results' },
      },
    },
  },
};

export const gmailGetMessageDef: GmailToolMeta = {
  category: 'gmail',
  riskLevel: RiskLevel.Low,
  definition: {
    name: 'gmail_get_message',
    description: 'Get the full content of a single email message by its ID.',
    input_schema: {
      type: 'object',
      properties: {
        message_id: { type: 'string', description: 'The Gmail message ID' },
        format: { type: 'string', enum: ['minimal', 'metadata', 'full'], description: 'Message format (default "full")' },
      },
      required: ['message_id'],
    },
  },
};

export const gmailMarkReadDef: GmailToolMeta = {
  category: 'gmail',
  riskLevel: RiskLevel.Low,
  definition: {
    name: 'gmail_mark_read',
    description: 'Mark one or more messages as read.',
    input_schema: {
      type: 'object',
      properties: {
        message_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Message IDs to mark as read',
        },
      },
      required: ['message_ids'],
    },
  },
};

export const gmailDraftDef: GmailToolMeta = {
  category: 'gmail',
  riskLevel: RiskLevel.Low,
  definition: {
    name: 'gmail_draft',
    description: 'Create a draft email. The draft will appear in Gmail Drafts for user review.',
    input_schema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Recipient email address' },
        subject: { type: 'string', description: 'Email subject line' },
        body: { type: 'string', description: 'Email body (plain text)' },
        in_reply_to: { type: 'string', description: 'Message-ID header of the email being replied to' },
      },
      required: ['to', 'subject', 'body'],
    },
  },
};

// ── Medium-risk tools (modifying actions) ───────────────────────────
// All include a `confidence` parameter for the LLM to self-report
// certainty about the action.

export const gmailArchiveDef: GmailToolMeta = {
  category: 'gmail',
  riskLevel: RiskLevel.Medium,
  definition: {
    name: 'gmail_archive',
    description: 'Archive a message (remove from inbox). Include a confidence score (0-1) indicating how certain you are this action is correct.',
    input_schema: {
      type: 'object',
      properties: {
        message_id: { type: 'string', description: 'Message ID to archive' },
        confidence: { type: 'number', description: 'Confidence score (0-1) for this action' },
      },
      required: ['message_id', 'confidence'],
    },
  },
};

export const gmailBatchArchiveDef: GmailToolMeta = {
  category: 'gmail',
  riskLevel: RiskLevel.Medium,
  definition: {
    name: 'gmail_batch_archive',
    description: 'Archive multiple messages at once. Include a confidence score (0-1) indicating how certain you are this action is correct.',
    input_schema: {
      type: 'object',
      properties: {
        message_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Message IDs to archive',
        },
        confidence: { type: 'number', description: 'Confidence score (0-1) for this action' },
      },
      required: ['message_ids', 'confidence'],
    },
  },
};

export const gmailLabelDef: GmailToolMeta = {
  category: 'gmail',
  riskLevel: RiskLevel.Medium,
  definition: {
    name: 'gmail_label',
    description: 'Add or remove labels on a message. Include a confidence score (0-1) indicating how certain you are this action is correct.',
    input_schema: {
      type: 'object',
      properties: {
        message_id: { type: 'string', description: 'Message ID' },
        add_label_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Label IDs to add',
        },
        remove_label_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Label IDs to remove',
        },
        confidence: { type: 'number', description: 'Confidence score (0-1) for this action' },
      },
      required: ['message_id', 'confidence'],
    },
  },
};

export const gmailBatchLabelDef: GmailToolMeta = {
  category: 'gmail',
  riskLevel: RiskLevel.Medium,
  definition: {
    name: 'gmail_batch_label',
    description: 'Add or remove labels on multiple messages. Include a confidence score (0-1) indicating how certain you are this action is correct.',
    input_schema: {
      type: 'object',
      properties: {
        message_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Message IDs',
        },
        add_label_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Label IDs to add',
        },
        remove_label_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Label IDs to remove',
        },
        confidence: { type: 'number', description: 'Confidence score (0-1) for this action' },
      },
      required: ['message_ids', 'confidence'],
    },
  },
};

export const gmailTrashDef: GmailToolMeta = {
  category: 'gmail',
  riskLevel: RiskLevel.Medium,
  definition: {
    name: 'gmail_trash',
    description: 'Move a message to trash. Include a confidence score (0-1) indicating how certain you are this action is correct.',
    input_schema: {
      type: 'object',
      properties: {
        message_id: { type: 'string', description: 'Message ID to trash' },
        confidence: { type: 'number', description: 'Confidence score (0-1) for this action' },
      },
      required: ['message_id', 'confidence'],
    },
  },
};

export const gmailSendDef: GmailToolMeta = {
  category: 'gmail',
  riskLevel: RiskLevel.Medium,
  definition: {
    name: 'gmail_send',
    description: 'Send an email. This is a medium-risk action that defaults to requiring user approval (overridable via trust rules). Include a confidence score (0-1).',
    input_schema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Recipient email address' },
        subject: { type: 'string', description: 'Email subject line' },
        body: { type: 'string', description: 'Email body (plain text)' },
        in_reply_to: { type: 'string', description: 'Message-ID header for replies' },
        confidence: { type: 'number', description: 'Confidence score (0-1) for this action' },
      },
      required: ['to', 'subject', 'body', 'confidence'],
    },
  },
};

export const gmailUnsubscribeDef: GmailToolMeta = {
  category: 'gmail',
  riskLevel: RiskLevel.Medium,
  definition: {
    name: 'gmail_unsubscribe',
    description: 'Unsubscribe from a mailing list by following the List-Unsubscribe header. Include a confidence score (0-1).',
    input_schema: {
      type: 'object',
      properties: {
        message_id: { type: 'string', description: 'A message ID from the mailing list to unsubscribe from' },
        confidence: { type: 'number', description: 'Confidence score (0-1) for this action' },
      },
      required: ['message_id', 'confidence'],
    },
  },
};

/** All Gmail tool definitions for manifest registration. */
export const allGmailToolDefs: GmailToolMeta[] = [
  gmailSearchDef,
  gmailListMessagesDef,
  gmailGetMessageDef,
  gmailMarkReadDef,
  gmailDraftDef,
  gmailArchiveDef,
  gmailBatchArchiveDef,
  gmailLabelDef,
  gmailBatchLabelDef,
  gmailTrashDef,
  gmailSendDef,
  gmailUnsubscribeDef,
];
