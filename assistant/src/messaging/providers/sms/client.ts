/**
 * Low-level SMS operations.
 *
 * Outbound message delivery routes through the gateway's /deliver/sms
 * endpoint, which handles Twilio credential management and the Messages API.
 * The gateway resolves the `from` number using the optional assistantId or
 * its default Twilio phone number configuration.
 */

const DELIVERY_TIMEOUT_MS = 30_000;

export class SmsApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'SmsApiError';
  }
}

/** Payload accepted by the gateway's /deliver/sms endpoint. */
interface DeliverPayload {
  to: string;
  text: string;
  assistantId?: string;
}

/**
 * Send an SMS message via the gateway's /deliver/sms endpoint.
 */
export async function sendMessage(
  gatewayUrl: string,
  bearerToken: string,
  to: string,
  text: string,
  assistantId?: string,
): Promise<void> {
  const payload: DeliverPayload = { to, text };
  if (assistantId) {
    payload.assistantId = assistantId;
  }

  const url = `${gatewayUrl}/deliver/sms`;
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
    throw new SmsApiError(
      resp.status,
      `Gateway /deliver/sms failed (${resp.status}): ${body}`,
    );
  }
}
