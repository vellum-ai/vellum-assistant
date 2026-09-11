import { expect, test } from 'bun:test';
import type { ChromeDebuggerApi } from '../cdp-proxy.js';

function event<Args extends unknown[]>() {
  const listeners = new Set<(...args: Args) => void>();
  return {
    addListener: (listener: (...args: Args) => void) => { listeners.add(listener); },
    removeListener: (listener: (...args: Args) => void) => { listeners.delete(listener); },
    fire: (...args: Args) => { for (const listener of listeners) { listener(...args); } },
  };
}

async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 1000;
  while (!condition()) {
    if (Date.now() > deadline) { throw new Error('Worker did not respond'); }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

test('native reconnect retries held input before announcing readiness', async () => {
  const previousChrome = Object.getOwnPropertyDescriptor(globalThis, 'chrome');
  const ports: Array<ChromeRuntimePort & {
    messages: Array<Record<string, unknown>>;
    onMessage: ReturnType<typeof event<[unknown]>>;
  }> = [];
  const alarm = event<[]>();
  const runtime = {
    lastError: undefined as { message: string } | undefined,
    getManifest: () => ({ version: '1.0.2' }),
    onStartup: event<[]>(),
    onInstalled: event<[]>(),
    connectNative: () => {
      const onDisconnect = event<[ChromeRuntimePort]>();
      let connected = true;
      const port = {
        name: 'desktop',
        messages: [] as Array<Record<string, unknown>>,
        onMessage: event<[unknown]>(),
        onDisconnect,
        postMessage(message: unknown) { this.messages.push(message as Record<string, unknown>); },
        disconnect() {
          if (connected) {
            connected = false;
            onDisconnect.fire(this);
          }
        },
      };
      ports.push(port);
      return port;
    },
  };
  let failedReleases = 2;
  let releases = 0;
  const commands: string[] = [];
  const debuggerApi: ChromeDebuggerApi = {
    runtime,
    attach: (_target, _version, callback) => { callback?.(); },
    detach: (_target, callback) => { callback?.(); },
    onEvent: event<Parameters<Parameters<ChromeDebuggerApi['onEvent']['addListener']>[0]>>(),
    onDetach: event<Parameters<Parameters<ChromeDebuggerApi['onDetach']['addListener']>[0]>>(),
    sendCommand: (_target, method, params, callback) => {
      commands.push(`${method}:${params?.type ?? ''}`);
      if (params?.type === 'keyUp') {
        releases++;
        if (failedReleases-- > 0) { runtime.lastError = { message: 'temporarily busy' }; }
      }
      callback?.({});
      runtime.lastError = undefined;
    },
  };
  Object.defineProperty(globalThis, 'chrome', { configurable: true, value: {
    runtime,
    debugger: debuggerApi,
    alarms: { onAlarm: alarm, create: async () => {} },
    tabs: { get: async (id: number) => ({ id }) },
  } });
  try {
    await import('../managed-desktop-worker.js');
    await until(() => ports[0]?.messages.length === 1);
    ports[0]!.onMessage.fire({
      type: 'host_browser_request', requestId: 'press', conversationId: 'conv-123',
      cdpSessionId: '42', cdpMethod: 'Input.dispatchKeyEvent',
      cdpParams: { type: 'keyDown', key: 'Shift' },
    });
    await until(() => ports[0]!.messages.some((message) => message.requestId === 'press'));
    ports[0]!.disconnect();
    await until(() => releases === 1);
    alarm.fire();
    await until(() => releases >= 3);
    expect(ports[1]!.messages).toEqual([]);
    alarm.fire();
    await until(() => ports[2]?.messages.length === 1);
    expect(ports[2]!.messages[0]!.type).toBe('desktop_browser_hello');
    expect(commands.filter((command) => command.startsWith('Input.'))).toEqual([
      'Input.dispatchKeyEvent:keyDown',
      'Input.dispatchKeyEvent:keyUp',
      'Input.dispatchKeyEvent:keyUp',
      'Input.dispatchKeyEvent:keyUp',
    ]);
  } finally {
    if (previousChrome) {
      Object.defineProperty(globalThis, 'chrome', previousChrome);
    } else {
      Reflect.deleteProperty(globalThis, 'chrome');
    }
  }
});
