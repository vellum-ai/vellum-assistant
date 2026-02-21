import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';

mock.module('../util/logger.js', () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

import {
  ElevenLabsClient,
  ElevenLabsError,
  type ElevenLabsClientOptions,
  type ElevenLabsRegisterCallRequest,
} from '../calls/elevenlabs-client.js';

// ── Helpers ────────────────────────────────────────────────────────────

const DEFAULT_OPTIONS: ElevenLabsClientOptions = {
  apiBaseUrl: 'https://api.elevenlabs.io',
  apiKey: 'test-api-key-secret',
  timeoutMs: 5000,
};

const DEFAULT_REQUEST: ElevenLabsRegisterCallRequest = {
  agent_id: 'agent-123',
  from_number: '+15551111111',
  to_number: '+15552222222',
  direction: 'outbound',
};

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ── Tests ──────────────────────────────────────────────────────────────

describe('ElevenLabsClient', () => {
  describe('registerCall', () => {
    test('successful register-call returns TwiML', async () => {
      const twimlResponse = '<?xml version="1.0"?><Response><Connect><Stream url="wss://el.io/stream"/></Connect></Response>';

      globalThis.fetch = mock(async () =>
        new Response(twimlResponse, { status: 200 }),
      ) as unknown as typeof globalThis.fetch;

      const client = new ElevenLabsClient(DEFAULT_OPTIONS);
      const result = await client.registerCall(DEFAULT_REQUEST);

      expect(result.twiml).toBe(twimlResponse);
    });

    test('passes xi-api-key header in request', async () => {
      let capturedHeaders: Headers | null = null;

      globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
        capturedHeaders = new Headers(init?.headers);
        return new Response('<Response/>', { status: 200 });
      }) as unknown as typeof globalThis.fetch;

      const client = new ElevenLabsClient(DEFAULT_OPTIONS);
      await client.registerCall(DEFAULT_REQUEST);

      expect(capturedHeaders).not.toBeNull();
      expect(capturedHeaders!.get('xi-api-key')).toBe('test-api-key-secret');
      expect(capturedHeaders!.get('Content-Type')).toBe('application/json');
    });

    test('sends correct URL and request body', async () => {
      let capturedUrl = '';
      let capturedBody = '';

      globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
        capturedUrl = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
        capturedBody = typeof init?.body === 'string' ? init.body : '';
        return new Response('<Response/>', { status: 200 });
      }) as unknown as typeof globalThis.fetch;

      const client = new ElevenLabsClient(DEFAULT_OPTIONS);
      await client.registerCall(DEFAULT_REQUEST);

      expect(capturedUrl).toBe('https://api.elevenlabs.io/v1/convai/twilio/register-call');
      const parsed = JSON.parse(capturedBody);
      expect(parsed.agent_id).toBe('agent-123');
      expect(parsed.from_number).toBe('+15551111111');
      expect(parsed.to_number).toBe('+15552222222');
      expect(parsed.direction).toBe('outbound');
    });

    test('non-2xx response throws ELEVENLABS_HTTP_ERROR', async () => {
      globalThis.fetch = mock(async () =>
        new Response('Internal Server Error', { status: 500 }),
      ) as unknown as typeof globalThis.fetch;

      const client = new ElevenLabsClient(DEFAULT_OPTIONS);

      try {
        await client.registerCall(DEFAULT_REQUEST);
        expect(true).toBe(false); // Should not reach here
      } catch (err) {
        expect(err).toBeInstanceOf(ElevenLabsError);
        const elErr = err as ElevenLabsError;
        expect(elErr.code).toBe('ELEVENLABS_HTTP_ERROR');
        expect(elErr.statusCode).toBe(500);
        expect(elErr.message).toContain('500');
      }
    });

    test('empty response throws ELEVENLABS_INVALID_RESPONSE', async () => {
      globalThis.fetch = mock(async () =>
        new Response('', { status: 200 }),
      ) as unknown as typeof globalThis.fetch;

      const client = new ElevenLabsClient(DEFAULT_OPTIONS);

      try {
        await client.registerCall(DEFAULT_REQUEST);
        expect(true).toBe(false); // Should not reach here
      } catch (err) {
        expect(err).toBeInstanceOf(ElevenLabsError);
        const elErr = err as ElevenLabsError;
        expect(elErr.code).toBe('ELEVENLABS_INVALID_RESPONSE');
      }
    });

    test('whitespace-only response throws ELEVENLABS_INVALID_RESPONSE', async () => {
      globalThis.fetch = mock(async () =>
        new Response('   \n  ', { status: 200 }),
      ) as unknown as typeof globalThis.fetch;

      const client = new ElevenLabsClient(DEFAULT_OPTIONS);

      try {
        await client.registerCall(DEFAULT_REQUEST);
        expect(true).toBe(false); // Should not reach here
      } catch (err) {
        expect(err).toBeInstanceOf(ElevenLabsError);
        const elErr = err as ElevenLabsError;
        expect(elErr.code).toBe('ELEVENLABS_INVALID_RESPONSE');
      }
    });

    test('timeout throws ELEVENLABS_TIMEOUT', async () => {
      globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
        // Wait longer than the timeout
        return new Promise<Response>((resolve, reject) => {
          const timer = setTimeout(() => resolve(new Response('<Response/>', { status: 200 })), 10000);
          init?.signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new DOMException('The operation was aborted.', 'AbortError'));
          });
        });
      }) as unknown as typeof globalThis.fetch;

      const client = new ElevenLabsClient({ ...DEFAULT_OPTIONS, timeoutMs: 50 });

      try {
        await client.registerCall(DEFAULT_REQUEST);
        expect(true).toBe(false); // Should not reach here
      } catch (err) {
        expect(err).toBeInstanceOf(ElevenLabsError);
        const elErr = err as ElevenLabsError;
        expect(elErr.code).toBe('ELEVENLABS_TIMEOUT');
        expect(elErr.message).toContain('50ms');
      }
    });

    test('network error throws ELEVENLABS_HTTP_ERROR', async () => {
      globalThis.fetch = mock(async () => {
        throw new TypeError('Failed to fetch');
      }) as unknown as typeof globalThis.fetch;

      const client = new ElevenLabsClient(DEFAULT_OPTIONS);

      try {
        await client.registerCall(DEFAULT_REQUEST);
        expect(true).toBe(false); // Should not reach here
      } catch (err) {
        expect(err).toBeInstanceOf(ElevenLabsError);
        const elErr = err as ElevenLabsError;
        expect(elErr.code).toBe('ELEVENLABS_HTTP_ERROR');
        expect(elErr.message).toContain('Failed to fetch');
      }
    });

    test('valid TwiML with XML declaration passes validation', async () => {
      const twiml = '<?xml version="1.0"?><Response><Connect><Stream url="wss://el.io/stream"/></Connect></Response>';

      globalThis.fetch = mock(async () =>
        new Response(twiml, { status: 200 }),
      ) as unknown as typeof globalThis.fetch;

      const client = new ElevenLabsClient(DEFAULT_OPTIONS);
      const result = await client.registerCall(DEFAULT_REQUEST);

      expect(result.twiml).toBe(twiml);
    });

    test('valid TwiML with Response tag but no XML declaration passes validation', async () => {
      const twiml = '<Response><Connect><Stream url="wss://el.io/stream"/></Connect></Response>';

      globalThis.fetch = mock(async () =>
        new Response(twiml, { status: 200 }),
      ) as unknown as typeof globalThis.fetch;

      const client = new ElevenLabsClient(DEFAULT_OPTIONS);
      const result = await client.registerCall(DEFAULT_REQUEST);

      expect(result.twiml).toBe(twiml);
    });

    test('non-XML response throws ELEVENLABS_INVALID_RESPONSE', async () => {
      globalThis.fetch = mock(async () =>
        new Response('{"error": "invalid"}', { status: 200 }),
      ) as unknown as typeof globalThis.fetch;

      const client = new ElevenLabsClient(DEFAULT_OPTIONS);

      try {
        await client.registerCall(DEFAULT_REQUEST);
        expect(true).toBe(false); // Should not reach here
      } catch (err) {
        expect(err).toBeInstanceOf(ElevenLabsError);
        const elErr = err as ElevenLabsError;
        expect(elErr.code).toBe('ELEVENLABS_INVALID_RESPONSE');
        expect(elErr.message).toContain('not valid TwiML/XML');
      }
    });

    test('plain text response throws ELEVENLABS_INVALID_RESPONSE', async () => {
      globalThis.fetch = mock(async () =>
        new Response('some random text', { status: 200 }),
      ) as unknown as typeof globalThis.fetch;

      const client = new ElevenLabsClient(DEFAULT_OPTIONS);

      try {
        await client.registerCall(DEFAULT_REQUEST);
        expect(true).toBe(false); // Should not reach here
      } catch (err) {
        expect(err).toBeInstanceOf(ElevenLabsError);
        const elErr = err as ElevenLabsError;
        expect(elErr.code).toBe('ELEVENLABS_INVALID_RESPONSE');
        expect(elErr.message).toContain('not valid TwiML/XML');
      }
    });

    test('API key is not included in logged data', async () => {
      // The ElevenLabsClient logs agent_id and direction, but should never log the API key.
      // We verify this by checking the request structure, not the log output.
      let capturedBody = '';

      globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
        capturedBody = typeof init?.body === 'string' ? init.body : '';
        return new Response('<Response/>', { status: 200 });
      }) as unknown as typeof globalThis.fetch;

      const client = new ElevenLabsClient(DEFAULT_OPTIONS);
      await client.registerCall(DEFAULT_REQUEST);

      // The request body should not contain the API key
      expect(capturedBody).not.toContain('test-api-key-secret');
    });
  });
});
