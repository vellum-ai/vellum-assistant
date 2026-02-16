/**
 * Gmail tool executors.
 *
 * Each executor uses the token manager's withValidToken pattern to
 * get a valid OAuth2 token without exposing it to the LLM.
 */

import type { Tool, ToolContext, ToolExecutionResult } from '../types.js';
import { RiskLevel } from '../../permissions/types.js';
import { registerTool } from '../registry.js';
import { withValidToken } from '../../integrations/token-manager.js';
import { getIntegration } from '../../integrations/registry.js';
import * as gmail from '../../integrations/gmail/client.js';
import type { GmailMessageFormat } from '../../integrations/gmail/types.js';
import { isPrivateOrLocalHost, resolveHostAddresses, resolveRequestAddress } from '../network/url-safety.js';
import {
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
} from './definitions.js';

function getGmailDef() {
  const def = getIntegration('gmail');
  if (!def) throw new Error('Gmail integration not registered');
  return def;
}

function ok(content: string): ToolExecutionResult {
  return { content, isError: false };
}

function err(message: string): ToolExecutionResult {
  return { content: message, isError: true };
}

function makeGmailTool(
  meta: { definition: { name: string; description: string; input_schema: unknown }; riskLevel: RiskLevel; category: string },
  executor: (input: Record<string, unknown>, context: ToolContext) => Promise<ToolExecutionResult>,
): Tool {
  return {
    name: meta.definition.name,
    description: meta.definition.description,
    category: meta.category,
    defaultRiskLevel: meta.riskLevel,
    getDefinition() {
      return meta.definition as ReturnType<Tool['getDefinition']>;
    },
    execute: executor,
  };
}

// ── Tool implementations ────────────────────────────────────────────

const gmailSearch = makeGmailTool(gmailSearchDef, async (input) => {
  const def = getGmailDef();
  const query = input.query as string;
  const maxResults = Math.min((input.max_results as number) ?? 20, 200);
  const format = (input.format as GmailMessageFormat) ?? 'metadata';
  const metadataHeaders = input.metadata_headers as string[] | undefined;

  return withValidToken('gmail', def, async (token) => {
    const listResult = await gmail.listMessages(token, query, maxResults);
    if (!listResult.messages?.length) {
      return ok('No messages found.');
    }

    if (format === 'minimal') {
      return ok(JSON.stringify(listResult, null, 2));
    }

    const messages = await gmail.batchGetMessages(
      token,
      listResult.messages.map((m) => m.id),
      format,
      metadataHeaders,
    );
    return ok(JSON.stringify({
      resultSizeEstimate: listResult.resultSizeEstimate,
      nextPageToken: listResult.nextPageToken,
      messages,
    }, null, 2));
  });
});

const gmailListMessages = makeGmailTool(gmailListMessagesDef, async (input) => {
  const def = getGmailDef();
  const maxResults = Math.min((input.max_results as number) ?? 20, 200);
  const labelIds = input.label_ids as string[] | undefined;
  const pageToken = input.page_token as string | undefined;

  return withValidToken('gmail', def, async (token) => {
    const result = await gmail.listMessages(token, undefined, maxResults, pageToken, labelIds);
    return ok(JSON.stringify(result, null, 2));
  });
});

const gmailGetMessage = makeGmailTool(gmailGetMessageDef, async (input) => {
  const def = getGmailDef();
  const messageId = input.message_id as string;
  const format = (input.format as GmailMessageFormat) ?? 'full';

  return withValidToken('gmail', def, async (token) => {
    const message = await gmail.getMessage(token, messageId, format);
    return ok(JSON.stringify(message, null, 2));
  });
});

const gmailMarkRead = makeGmailTool(gmailMarkReadDef, async (input) => {
  const def = getGmailDef();
  const messageIds = input.message_ids as string[];

  return withValidToken('gmail', def, async (token) => {
    await gmail.batchModifyMessages(token, messageIds, { removeLabelIds: ['UNREAD'] });
    return ok(`Marked ${messageIds.length} message(s) as read.`);
  });
});

const gmailDraft = makeGmailTool(gmailDraftDef, async (input) => {
  const def = getGmailDef();
  const to = input.to as string;
  const subject = input.subject as string;
  const body = input.body as string;
  const inReplyTo = input.in_reply_to as string | undefined;

  return withValidToken('gmail', def, async (token) => {
    const draft = await gmail.createDraft(token, to, subject, body, inReplyTo);
    return ok(`Draft created (ID: ${draft.id}). It will appear in your Gmail Drafts.`);
  });
});

const gmailArchive = makeGmailTool(gmailArchiveDef, async (input) => {
  const def = getGmailDef();
  const messageId = input.message_id as string;

  return withValidToken('gmail', def, async (token) => {
    await gmail.modifyMessage(token, messageId, { removeLabelIds: ['INBOX'] });
    return ok('Message archived.');
  });
});

const gmailBatchArchive = makeGmailTool(gmailBatchArchiveDef, async (input) => {
  const def = getGmailDef();
  const messageIds = input.message_ids as string[];

  return withValidToken('gmail', def, async (token) => {
    await gmail.batchModifyMessages(token, messageIds, { removeLabelIds: ['INBOX'] });
    return ok(`Archived ${messageIds.length} message(s).`);
  });
});

const gmailLabel = makeGmailTool(gmailLabelDef, async (input) => {
  const def = getGmailDef();
  const messageId = input.message_id as string;
  const addLabelIds = input.add_label_ids as string[] | undefined;
  const removeLabelIds = input.remove_label_ids as string[] | undefined;

  return withValidToken('gmail', def, async (token) => {
    await gmail.modifyMessage(token, messageId, { addLabelIds, removeLabelIds });
    return ok('Labels updated.');
  });
});

const gmailBatchLabel = makeGmailTool(gmailBatchLabelDef, async (input) => {
  const def = getGmailDef();
  const messageIds = input.message_ids as string[];
  const addLabelIds = input.add_label_ids as string[] | undefined;
  const removeLabelIds = input.remove_label_ids as string[] | undefined;

  return withValidToken('gmail', def, async (token) => {
    await gmail.batchModifyMessages(token, messageIds, { addLabelIds, removeLabelIds });
    return ok(`Labels updated on ${messageIds.length} message(s).`);
  });
});

const gmailTrash = makeGmailTool(gmailTrashDef, async (input) => {
  const def = getGmailDef();
  const messageId = input.message_id as string;

  return withValidToken('gmail', def, async (token) => {
    await gmail.trashMessage(token, messageId);
    return ok('Message moved to trash.');
  });
});

const gmailSend = makeGmailTool(gmailSendDef, async (input) => {
  const def = getGmailDef();
  const to = input.to as string;
  const subject = input.subject as string;
  const body = input.body as string;
  const inReplyTo = input.in_reply_to as string | undefined;

  return withValidToken('gmail', def, async (token) => {
    const message = await gmail.sendMessage(token, to, subject, body, inReplyTo);
    return ok(`Email sent (ID: ${message.id}).`);
  });
});

const gmailUnsubscribe = makeGmailTool(gmailUnsubscribeDef, async (input) => {
  const def = getGmailDef();
  const messageId = input.message_id as string;

  return withValidToken('gmail', def, async (token) => {
    // Fetch message to get List-Unsubscribe header
    const message = await gmail.getMessage(token, messageId, 'metadata', ['List-Unsubscribe', 'List-Unsubscribe-Post']);
    const headers = message.payload?.headers ?? [];
    const unsubHeader = headers.find((h) => h.name.toLowerCase() === 'list-unsubscribe')?.value;

    if (!unsubHeader) {
      return err('No List-Unsubscribe header found. Manual unsubscribe may be required.');
    }

    // Parse List-Unsubscribe header — can contain mailto: and/or https: URLs
    const httpsMatch = unsubHeader.match(/<(https:\/\/[^>]+)>/);
    const mailtoMatch = unsubHeader.match(/<mailto:([^>]+)>/);
    const postHeader = headers.find((h) => h.name.toLowerCase() === 'list-unsubscribe-post')?.value;

    if (httpsMatch) {
      const url = httpsMatch[1];
      // SSRF protection: validate URL against private/internal addresses
      let parsed: URL;
      try {
        parsed = new URL(url);
        if (parsed.protocol !== 'https:') {
          return err('Unsubscribe URL must use HTTPS.');
        }
        if (isPrivateOrLocalHost(parsed.hostname)) {
          return err('Unsubscribe URL points to a private or local address.');
        }
        // DNS resolution check to catch DNS rebinding attacks
        const { blockedAddress } = await resolveRequestAddress(parsed.hostname, resolveHostAddresses, false);
        if (blockedAddress) {
          return err('Unsubscribe URL resolves to a private or local address.');
        }
      } catch {
        return err('Invalid unsubscribe URL.');
      }

      // RFC 8058: use POST with List-Unsubscribe-Post header if present
      if (postHeader) {
        const resp = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: postHeader,
          redirect: 'manual',
        });
        if (resp.ok) {
          return ok('Successfully unsubscribed via HTTPS POST.');
        }
        return err(`Unsubscribe request failed: ${resp.status} ${resp.statusText}`);
      }

      // Fallback: GET request
      const resp = await fetch(url, { redirect: 'manual' });
      if (resp.ok) {
        return ok('Successfully unsubscribed via HTTPS GET.');
      }
      return err(`Unsubscribe request failed: ${resp.status} ${resp.statusText}`);
    }

    if (mailtoMatch) {
      // Send unsubscribe email
      const mailtoAddr = mailtoMatch[1].split('?')[0];
      await gmail.sendMessage(token, mailtoAddr, 'Unsubscribe', 'Unsubscribe');
      return ok(`Unsubscribe email sent to ${mailtoAddr}.`);
    }

    return err('No supported unsubscribe method found (requires https: or mailto: URL).');
  });
});

// ── Registration ────────────────────────────────────────────────────

const allGmailTools: Tool[] = [
  gmailSearch,
  gmailListMessages,
  gmailGetMessage,
  gmailMarkRead,
  gmailDraft,
  gmailArchive,
  gmailBatchArchive,
  gmailLabel,
  gmailBatchLabel,
  gmailTrash,
  gmailSend,
  gmailUnsubscribe,
];

for (const tool of allGmailTools) {
  registerTool(tool);
}
