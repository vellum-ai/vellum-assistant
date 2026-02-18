import { describe, test, expect } from 'bun:test';
import type { ProxyResolver } from '../tools/apps/executors.js';
import { openAppViaSurface } from '../tools/apps/open-proxy.js';

describe('openAppViaSurface', () => {
  test('returns proxy result content on success', async () => {
    const resolver: ProxyResolver = async (_name, _input) => ({
      content: 'opened-surface-123',
      isError: false,
    });

    const result = await openAppViaSurface('app-1', resolver);
    expect(result).toBe('opened-surface-123');
  });

  test('passes app_id and extraInput to the resolver', async () => {
    let capturedName: string | undefined;
    let capturedInput: Record<string, unknown> | undefined;

    const resolver: ProxyResolver = async (name, input) => {
      capturedName = name;
      capturedInput = input;
      return { content: 'ok', isError: false };
    };

    await openAppViaSurface('my-app', resolver, { preview: { title: 'Hello' } });

    expect(capturedName).toBe('app_open');
    expect(capturedInput).toEqual({
      app_id: 'my-app',
      preview: { title: 'Hello' },
    });
  });

  test('returns informational message when resolver is undefined', async () => {
    const result = await openAppViaSurface('app-1', undefined);
    expect(result).toBe(
      'App created but could not be opened (no connected client). Use app_open to open it manually.',
    );
  });

  test('returns fallback text when resolver throws', async () => {
    const resolver: ProxyResolver = async () => {
      throw new Error('connection lost');
    };

    const result = await openAppViaSurface('app-1', resolver);
    expect(result).toBe('Failed to auto-open app. Use app_open to open it manually.');
  });

  test('omits extraInput fields when not provided', async () => {
    let capturedInput: Record<string, unknown> | undefined;

    const resolver: ProxyResolver = async (_name, input) => {
      capturedInput = input;
      return { content: 'ok', isError: false };
    };

    await openAppViaSurface('app-2', resolver);
    expect(capturedInput).toEqual({ app_id: 'app-2' });
  });
});
