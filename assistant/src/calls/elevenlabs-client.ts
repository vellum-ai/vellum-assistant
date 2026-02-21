import { getLogger } from '../util/logger.js';

const log = getLogger('elevenlabs-client');

export interface ElevenLabsRegisterCallRequest {
  agent_id: string;
  from_number: string;
  to_number: string;
  direction: 'outbound' | 'inbound';
  conversation_initiation_client_data?: Record<string, unknown>;
}

export interface ElevenLabsRegisterCallResult {
  twiml: string;
}

export interface ElevenLabsClientOptions {
  apiBaseUrl: string;
  apiKey: string;
  timeoutMs: number;
}

export type ElevenLabsErrorCode = 'ELEVENLABS_TIMEOUT' | 'ELEVENLABS_HTTP_ERROR' | 'ELEVENLABS_INVALID_RESPONSE';

export class ElevenLabsError extends Error {
  code: ElevenLabsErrorCode;
  statusCode?: number;

  constructor(code: ElevenLabsErrorCode, message: string, statusCode?: number) {
    super(message);
    this.name = 'ElevenLabsError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

export class ElevenLabsClient {
  private options: ElevenLabsClientOptions;

  constructor(options: ElevenLabsClientOptions) {
    this.options = options;
  }

  async registerCall(request: ElevenLabsRegisterCallRequest): Promise<ElevenLabsRegisterCallResult> {
    const url = `${this.options.apiBaseUrl}/v1/convai/twilio/register-call`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs);

    try {
      log.info({ agent_id: request.agent_id, direction: request.direction }, 'Registering call with ElevenLabs');

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'xi-api-key': this.options.apiKey,
        },
        body: JSON.stringify(request),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new ElevenLabsError(
          'ELEVENLABS_HTTP_ERROR',
          `ElevenLabs register-call returned ${response.status}`,
          response.status,
        );
      }

      const body = await response.text();
      if (!body || body.trim().length === 0) {
        throw new ElevenLabsError(
          'ELEVENLABS_INVALID_RESPONSE',
          'ElevenLabs register-call returned empty response',
        );
      }

      const lower = body.toLowerCase();
      if (!lower.includes('<?xml') && !lower.includes('<response')) {
        throw new ElevenLabsError(
          'ELEVENLABS_INVALID_RESPONSE',
          'Register-call response is not valid TwiML/XML',
        );
      }

      return { twiml: body };
    } catch (err) {
      if (err instanceof ElevenLabsError) throw err;
      if (err instanceof Error && err.name === 'AbortError') {
        throw new ElevenLabsError('ELEVENLABS_TIMEOUT', `ElevenLabs register-call timed out after ${this.options.timeoutMs}ms`);
      }
      throw new ElevenLabsError('ELEVENLABS_HTTP_ERROR', `ElevenLabs register-call failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      clearTimeout(timeout);
    }
  }
}
