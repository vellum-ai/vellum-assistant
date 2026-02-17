import type { ToolContext, ToolExecutionResult } from '../../../../tools/types.js';
import * as gmail from '../../../../integrations/gmail/client.js';
import { isPrivateOrLocalHost, resolveHostAddresses, resolveRequestAddress } from '../../../../tools/network/url-safety.js';
import { withGmailToken, ok, err, pinnedHttpsRequest } from './shared.js';

export async function run(input: Record<string, unknown>, _context: ToolContext): Promise<ToolExecutionResult> {
  const messageId = input.message_id as string;

  return withGmailToken(async (token) => {
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
      let validatedAddresses: string[];
      try {
        parsed = new URL(url);
        if (parsed.protocol !== 'https:') {
          return err('Unsubscribe URL must use HTTPS.');
        }
        if (isPrivateOrLocalHost(parsed.hostname)) {
          return err('Unsubscribe URL points to a private or local address.');
        }
        // DNS resolution check — reuse validated addresses for the fetch to prevent TOCTOU
        const { addresses, blockedAddress } = await resolveRequestAddress(parsed.hostname, resolveHostAddresses, false);
        if (blockedAddress) {
          return err('Unsubscribe URL resolves to a private or local address.');
        }
        if (addresses.length === 0) {
          return err('Unable to resolve unsubscribe URL hostname.');
        }
        validatedAddresses = addresses;
      } catch {
        return err('Invalid unsubscribe URL.');
      }

      // Try each validated address for dual-stack/multi-A reliability
      const method = postHeader ? 'POST' : 'GET';
      const reqOpts = postHeader
        ? { method: 'POST' as const, headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: postHeader }
        : undefined;

      let lastStatus = 0;
      for (const address of validatedAddresses) {
        try {
          lastStatus = await pinnedHttpsRequest(parsed, address, reqOpts);
          if (lastStatus >= 200 && lastStatus < 400) {
            return ok(`Successfully unsubscribed via HTTPS ${method}.`);
          }
        } catch {
          // Try next address
          continue;
        }
      }
      return err(`Unsubscribe request failed: ${lastStatus}`);
    }

    if (mailtoMatch) {
      // Send unsubscribe email
      const mailtoAddr = mailtoMatch[1].split('?')[0];
      await gmail.sendMessage(token, mailtoAddr, 'Unsubscribe', 'Unsubscribe');
      return ok(`Unsubscribe email sent to ${mailtoAddr}.`);
    }

    return err('No supported unsubscribe method found (requires https: or mailto: URL).');
  });
}
