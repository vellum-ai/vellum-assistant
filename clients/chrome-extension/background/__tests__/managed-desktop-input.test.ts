import { expect, test } from 'bun:test';
import { trackDesktopInput } from '../managed-desktop-input.js';
import type { CdpProxy, CdpRequestFrame } from '../cdp-proxy.js';

test('releases input already dispatched when cancellation interrupts its response', async () => {
  const calls: CdpRequestFrame[] = [];
  let finish!: (value: { id: number }) => void;
  const proxy = { send: async (_target, frame) => {
    calls.push(frame);
    if (frame.params?.type === 'mousePressed') {
      return new Promise<{ id: number }>((resolve) => { finish = resolve; });
    }
    return { id: frame.id };
  } } as CdpProxy;
  const input = trackDesktopInput(proxy);
  const pressed = input.proxy.send({ tabId: 42 }, { id: 1, method: 'Input.dispatchMouseEvent', params: { type: 'mousePressed', button: 'left', x: 5, y: 7 } });
  await input.release();
  expect(calls.map((frame) => frame.params?.type)).toEqual(['mousePressed', 'mouseReleased']);
  finish({ id: 1 });
  await pressed;
  await input.release();
  expect(calls.length).toBe(2);
});

test('failed key-up remains available to takeover cleanup', async () => {
  let failRelease = true;
  let releases = 0;
  const proxy = { send: async (_target, frame) => {
    if (frame.params?.type === 'keyUp') {
      releases++;
      if (failRelease) { return { id: frame.id, error: { code: -1, message: 'busy' } }; }
    }
    return { id: frame.id };
  } } as CdpProxy;
  const input = trackDesktopInput(proxy);
  const target = { tabId: 42 };
  await input.proxy.send(target, { id: 1, method: 'Input.dispatchKeyEvent', params: { type: 'keyDown', key: 'Enter' } });
  await input.proxy.send(target, { id: 2, method: 'Input.dispatchKeyEvent', params: { type: 'keyUp', key: 'Enter' } });
  failRelease = false;
  await input.release();
  expect(releases).toBe(2);
});
