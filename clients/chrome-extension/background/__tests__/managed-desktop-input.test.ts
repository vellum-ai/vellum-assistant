import { expect, test } from 'bun:test';
import { trackDesktopInput } from '../managed-desktop-input.js';
import type { CdpProxy, CdpRequestFrame } from '../cdp-proxy.js';

function makeProxy(overrides: Pick<CdpProxy, 'send'> & Partial<CdpProxy>): CdpProxy {
  return {
    attach: async () => {},
    detach: async () => {},
    onDetach: () => () => {},
    onEvent: () => () => {},
    dispose: () => {},
    ...overrides,
  };
}

test('releases input already dispatched when cancellation interrupts its response', async () => {
  const calls: CdpRequestFrame[] = [];
  let finish!: (value: { id: number }) => void;
  const proxy = makeProxy({ send: async (_target, frame) => {
    calls.push(frame);
    if (frame.params?.type === 'mousePressed') {
      return new Promise<{ id: number }>((resolve) => { finish = resolve; });
    }
    return { id: frame.id };
  } });
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
  const proxy = makeProxy({ send: async (_target, frame) => {
    if (frame.params?.type === 'keyUp') {
      releases++;
      if (failRelease) { return { id: frame.id, error: { code: -1, message: 'busy' } }; }
    }
    return { id: frame.id };
  } });
  const input = trackDesktopInput(proxy);
  const target = { tabId: 42 };
  await input.proxy.send(target, { id: 1, method: 'Input.dispatchKeyEvent', params: { type: 'keyDown', key: 'Enter' } });
  await input.proxy.send(target, { id: 2, method: 'Input.dispatchKeyEvent', params: { type: 'keyUp', key: 'Enter' } });
  failRelease = false;
  await input.release();
  expect(releases).toBe(2);
});

test('detached targets cannot block cleanup of live targets', async () => {
  let detached!: Parameters<CdpProxy['onDetach']>[0];
  const released: number[] = [];
  const proxy = makeProxy({
    onDetach: (callback) => { detached = callback; return () => {}; },
    send: async (target, frame) => {
      if (frame.params?.type === 'keyUp') {
        released.push(target.tabId!);
        if (target.tabId === 42) { throw new Error('Target closed'); }
      }
      return { id: frame.id };
    },
  });
  const input = trackDesktopInput(proxy);
  for (const tabId of [42, 43]) {
    await input.proxy.send({ tabId }, { id: tabId, method: 'Input.dispatchKeyEvent', params: { type: 'keyDown', key: 'Enter' } });
  }
  detached({ tabId: 42 }, 'target_closed');
  await input.release();
  expect(released).toEqual([43]);
});

test('a detach during cleanup discards the failed release', async () => {
  let detached!: Parameters<CdpProxy['onDetach']>[0];
  let releases = 0;
  const proxy = makeProxy({
    onDetach: (callback) => { detached = callback; return () => {}; },
    send: async (target, frame) => {
      if (frame.params?.type === 'mouseReleased') {
        releases++;
        detached(target, 'target_closed');
        return { id: frame.id, error: { code: -32000, message: 'Target closed' } };
      }
      return { id: frame.id };
    },
  });
  const input = trackDesktopInput(proxy);
  await input.proxy.send({ tabId: 42 }, { id: 1, method: 'Input.dispatchMouseEvent', params: { type: 'mousePressed', button: 'left' } });
  await input.release();
  await input.release();
  expect(releases).toBe(1);
});

for (const alreadyHeld of [false, true]) {
  test(`a rejected press preserves only prior held input (${alreadyHeld})`, async () => {
  let presses = 0;
  let releases = 0;
  const proxy = makeProxy({
    send: async (_target, frame) => {
      if (frame.params?.type === 'keyDown') {
        if (!alreadyHeld || presses++ > 0) {
          return { id: frame.id, error: { code: -32000, message: 'Command rejected' } };
        }
      } else if (frame.params?.type === 'keyUp') {
        releases++;
      }
      return { id: frame.id };
    },
  });
  const input = trackDesktopInput(proxy);
  const frame = { id: 1, method: 'Input.dispatchKeyEvent', params: { type: 'keyDown', key: 'Enter' } };
  if (alreadyHeld) { await input.proxy.send({ tabId: 42 }, frame); }
  await input.proxy.send({ tabId: 42 }, frame);
  await input.release();
  expect(releases).toBe(alreadyHeld ? 1 : 0);
  });
}
