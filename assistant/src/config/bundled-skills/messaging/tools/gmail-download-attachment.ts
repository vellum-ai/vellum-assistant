import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { ToolContext, ToolExecutionResult } from '../../../../tools/types.js';
import { withValidToken } from '../../../../security/token-manager.js';
import { getMessagingProvider } from '../../../../messaging/registry.js';
import { getAttachment } from '../../../../messaging/providers/gmail/client.js';
import { ok, err } from './shared.js';

export async function run(input: Record<string, unknown>, context: ToolContext): Promise<ToolExecutionResult> {
  const messageId = input.message_id as string;
  const attachmentId = input.attachment_id as string;
  const filename = input.filename as string;

  if (!messageId) return err('message_id is required.');
  if (!attachmentId) return err('attachment_id is required.');
  if (!filename) return err('filename is required.');

  try {
    const provider = getMessagingProvider('gmail');
    return withValidToken(provider.credentialService, async (token) => {
      const attachment = await getAttachment(token, messageId, attachmentId);

      // Gmail returns base64url; convert to standard base64 then to Buffer
      const base64 = attachment.data.replace(/-/g, '+').replace(/_/g, '/');
      const buffer = Buffer.from(base64, 'base64');

      const outputDir = context.workingDir ?? process.cwd();
      const outputPath = resolve(outputDir, filename);
      await writeFile(outputPath, buffer);

      return ok(`Attachment saved to ${outputPath} (${buffer.length} bytes).`);
    });
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
