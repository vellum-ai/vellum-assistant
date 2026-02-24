/**
 * Low-level WhatsApp operations.
 *
 * Outbound message delivery routes through the gateway's /deliver/whatsapp
 * endpoint, which handles WhatsApp credential management and the Meta Cloud API.
 */

const DELIVERY_TIMEOUT_MS = 30_000;

export class WhatsAppApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'WhatsAppApiError';
  }
}

/** Payload accepted by the gateway's /deliver/whatsapp endpoint. */
interface DeliverPayload {
  to: string;
  text: string;
  assistantId?: string;
}

/** Result returned by sendMessage. */
export interface WhatsAppSendResult {
  ok: boolean;
}

/**
 * Send a WhatsApp message via the gateway's /deliver/whatsapp endpoint.
 */
export async function sendMessage(
  gatewayUrl: string,
  bearerToken: string,
  to: string,
  text: string,
  assistantId?: string,
): Promise<WhatsAppSendResult> {
  const payload: DeliverPayload = { to, text };
  if (assistantId) {
    payload.assistantId = assistantId;
  }

  const url = `${gatewayUrl}/deliver/whatsapp`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${bearerToken}`,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => '<unreadable>');
    throw new WhatsAppApiError(
      resp.status,
      `Gateway /deliver/whatsapp failed (${resp.status}): ${body}`,
    );
  }

  return { ok: true };
}
