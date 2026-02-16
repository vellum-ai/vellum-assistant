import type { ContentBlock } from '../providers/types.js';
import type { UserMessageAttachment } from './ipc-protocol.js';
import { check, classifyRisk, generateAllowlistOptions, generateScopeOptions } from '../permissions/checker.js';
import { addRule } from '../permissions/trust-store.js';
import type { PermissionPrompter } from '../permissions/prompter.js';
import { uploadAttachment, linkAttachmentToMessage } from '../memory/attachments-store.js';
import {
  resolveDirectives,
  contentBlocksToDrafts,
  deduplicateDrafts,
  validateDrafts,
  type DirectiveRequest,
  type AssistantAttachmentDraft,
  type ApproveHostRead,
} from './assistant-attachments.js';
import { getLogger } from '../util/logger.js';

const log = getLogger('session-attachments');

/**
 * Approve reading a host file for assistant attachment resolution.
 * Checks the permission store and prompts the user if needed.
 */
export async function approveHostAttachmentRead(
  filePath: string,
  workingDir: string,
  prompter: PermissionPrompter,
  conversationId: string,
  hasNoClient: boolean,
): Promise<boolean> {
  const toolName = 'host_file_read';
  const input = { path: filePath };
  const decision = await check(toolName, input, workingDir);

  if (decision.decision === 'allow') {
    return true;
  }
  if (decision.decision === 'deny') {
    return false;
  }

  // HTTP-created sessions use a no-op sendToClient — prompting would
  // block for the full permission timeout before auto-denying.
  if (hasNoClient) {
    log.info({ filePath }, 'Denying host attachment read: no interactive client connected');
    return false;
  }

  const response = await prompter.prompt(
    toolName,
    input,
    await classifyRisk(toolName, input),
    generateAllowlistOptions(toolName, input),
    generateScopeOptions(workingDir, toolName),
    undefined,
    undefined,
    conversationId,
    'host',
  );

  if (response.decision === 'always_allow' && response.selectedPattern && response.selectedScope) {
    addRule(toolName, response.selectedPattern, response.selectedScope);
  }
  if (response.decision === 'always_deny' && response.selectedPattern && response.selectedScope) {
    addRule(toolName, response.selectedPattern, response.selectedScope, 'deny');
  }

  return response.decision === 'allow' || response.decision === 'always_allow';
}

export function formatAttachmentWarnings(warnings: string[]): string | null {
  if (warnings.length === 0) return null;
  const lines = warnings.map((warning) => `Attachment warning: ${warning}`);
  return `\n\n${lines.join('\n')}`;
}

export interface AttachmentResolutionResult {
  assistantAttachments: AssistantAttachmentDraft[];
  emittedAttachments: UserMessageAttachment[];
  directiveWarnings: string[];
}

/**
 * Resolve accumulated directives and tool content blocks into assistant
 * attachments. Persists attachments and links them to the assistant message.
 */
export async function resolveAssistantAttachments(
  accumulatedDirectives: DirectiveRequest[],
  accumulatedToolContentBlocks: ContentBlock[],
  directiveWarnings: string[],
  workingDir: string,
  approveHostRead: ApproveHostRead,
  lastAssistantMessageId: string | undefined,
  assistantScope: string,
): Promise<AttachmentResolutionResult> {
  let assistantAttachments: AssistantAttachmentDraft[] = [];
  const emittedAttachments: UserMessageAttachment[] = [];

  if (accumulatedDirectives.length > 0 || accumulatedToolContentBlocks.length > 0) {
    const directiveDrafts = accumulatedDirectives.length > 0
      ? await resolveDirectives(accumulatedDirectives, workingDir, approveHostRead)
      : { drafts: [], warnings: [] };
    directiveWarnings.push(...directiveDrafts.warnings);

    const toolDrafts = contentBlocksToDrafts(accumulatedToolContentBlocks);

    const merged = deduplicateDrafts([...directiveDrafts.drafts, ...toolDrafts]);
    const validated = validateDrafts(merged);
    directiveWarnings.push(...validated.warnings);
    assistantAttachments = validated.accepted;
  }

  // Persist resolved attachments and link to the last assistant message
  if (assistantAttachments.length > 0 && lastAssistantMessageId) {
    for (let i = 0; i < assistantAttachments.length; i++) {
      const draft = assistantAttachments[i];
      const stored = uploadAttachment(
        assistantScope,
        draft.filename,
        draft.mimeType,
        draft.dataBase64,
      );
      linkAttachmentToMessage(lastAssistantMessageId, stored.id, i);
      emittedAttachments.push({
        id: stored.id,
        filename: draft.filename,
        mimeType: draft.mimeType,
        data: draft.dataBase64,
      });
    }
  } else if (assistantAttachments.length > 0) {
    for (const draft of assistantAttachments) {
      emittedAttachments.push({
        filename: draft.filename,
        mimeType: draft.mimeType,
        data: draft.dataBase64,
      });
    }
  }

  return { assistantAttachments, emittedAttachments, directiveWarnings };
}
