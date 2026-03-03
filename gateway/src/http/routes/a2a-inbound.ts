/**
 * Gateway route for inbound A2A messages from peer assistants.
 *
 * This is the endpoint that a peer assistant's outbound delivery adapter
 * calls to send messages. The gateway acts as a transparent proxy:
 *
 * 1. Validates payload size and basic envelope structure
 * 2. Forwards the request (including all A2A auth headers) to the runtime's
 *    /v1/a2a/messages/inbound endpoint
 * 3. The runtime performs HMAC-SHA256 signature verification, connection
 *    validation, dedup, trust classification, and message routing
 *
 * The gateway does NOT verify A2A signatures — it passes the x-a2a-* headers
 * through to the runtime, which has access to the stored inbound credentials
 * needed for HMAC verification.
 */

import type { GatewayConfig } from '../../config.js';
import { getLogger } from '../../logger.js';
import type { A2AInboundEnvelope } from '../../a2a/normalize.js';
import { mintIngressToken } from '../../auth/token-exchange.js';
import { fetchImpl } from '../../fetch.js';

const log = getLogger('a2a-inbound');

/** Maximum payload size for A2A messages: 256 KB. */
const MAX_A2A_MESSAGE_BYTES = 256 * 1024;

const TIMEOUT_MS = 15_000;

export function createA2AInboundHandler(config: GatewayConfig) {
  /**
   * POST /v1/a2a/messages/inbound
   *
   * Accepts an A2A message envelope with HMAC-SHA256 auth headers.
   * Proxies to the runtime which verifies the signature, then routes
   * the message through the inbound pipeline with peer_assistant trust.
   */
  async function handleA2AInbound(req: Request, clientIp?: string): Promise<Response> {
    // Payload size guard
    const contentLength = req.headers.get('content-length');
    if (contentLength) {
      const declared = Number(contentLength);
      if (declared > MAX_A2A_MESSAGE_BYTES || Number.isNaN(declared)) {
        log.warn({ contentLength }, 'A2A inbound payload too large');
        return Response.json({ error: 'Payload too large' }, { status: 413 });
      }
    }

    let bodyText: string;
    try {
      const bodyBuffer = await req.arrayBuffer();
      if (bodyBuffer.byteLength > MAX_A2A_MESSAGE_BYTES) {
        log.warn({ bodyBytes: bodyBuffer.byteLength }, 'A2A inbound payload too large');
        return Response.json({ error: 'Payload too large' }, { status: 413 });
      }
      bodyText = new TextDecoder().decode(bodyBuffer);
    } catch {
      return Response.json({ error: 'Failed to read request body' }, { status: 400 });
    }

    let envelope: A2AInboundEnvelope;
    try {
      envelope = JSON.parse(bodyText) as A2AInboundEnvelope;
    } catch {
      return Response.json({ error: 'Invalid JSON' }, { status: 400 });
    }

    // Basic envelope validation
    if (!envelope.messageId || !envelope.connectionId || !envelope.senderAssistantId) {
      return Response.json(
        { error: 'Missing required fields: messageId, connectionId, senderAssistantId' },
        { status: 400 },
      );
    }

    if (!envelope.content || !envelope.content.type) {
      return Response.json(
        { error: 'Missing required field: content.type' },
        { status: 400 },
      );
    }

    if (!envelope.nonce) {
      return Response.json(
        { error: 'Missing required field: nonce' },
        { status: 400 },
      );
    }

    // Forward to runtime's A2A inbound endpoint with all A2A auth headers.
    // The runtime verifies the HMAC-SHA256 signature against the stored
    // inbound credential, then handles dedup, trust classification, and
    // message routing.
    const upstream = `${config.assistantRuntimeBaseUrl}/v1/a2a/messages/inbound`;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${mintIngressToken()}`,
    };

    // Pass through A2A auth headers for the runtime to verify
    const a2aHeaders = [
      'x-a2a-signature',
      'x-a2a-timestamp',
      'x-a2a-nonce',
      'x-a2a-connection-id',
    ];
    for (const header of a2aHeaders) {
      const value = req.headers.get(header);
      if (value) {
        headers[header] = value;
      }
    }

    if (clientIp) {
      headers['x-forwarded-for'] = clientIp;
    }

    try {
      const response = await fetchImpl(upstream, {
        method: 'POST',
        headers,
        body: bodyText,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });

      const resBody = await response.text();

      if (response.status >= 400) {
        log.warn(
          { status: response.status, connectionId: envelope.connectionId },
          'A2A inbound upstream error',
        );
      } else {
        log.info(
          { connectionId: envelope.connectionId, messageId: envelope.messageId },
          'A2A inbound message forwarded to runtime',
        );
      }

      return new Response(resBody, {
        status: response.status,
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'TimeoutError') {
        log.error({ connectionId: envelope.connectionId }, 'A2A inbound upstream timed out');
        return Response.json({ error: 'Gateway Timeout' }, { status: 504 });
      }
      log.error({ err, connectionId: envelope.connectionId }, 'A2A inbound upstream connection failed');
      return Response.json({ error: 'Bad Gateway' }, { status: 502 });
    }
  }

  return { handleA2AInbound };
}
