import type { CdpProxy, CdpRequestFrame, CdpTarget } from './cdp-proxy.js';

export function trackDesktopInput(proxy: CdpProxy): { proxy: CdpProxy; release: () => Promise<void> } {
  const held = new Map<string, { target: CdpTarget; frame: CdpRequestFrame }>();
  let sequence = -1;
  return {
    proxy: {
      ...proxy,
      send: async (target, frame) => {
        const params = frame.params ?? {};
        const key = JSON.stringify([target, frame.method, params.key ?? params.button]);
        if (params.type === 'keyDown' || params.type === 'rawKeyDown' || params.type === 'mousePressed') {
          held.set(key, { target, frame: { ...frame, params: { ...params, type: frame.method === 'Input.dispatchKeyEvent' ? 'keyUp' : 'mouseReleased' } } });
        }
        const heldInput = held.get(key);
        const result = await proxy.send(target, frame);
        if (!result.error && (params.type === 'keyUp' || params.type === 'mouseReleased') && held.get(key) === heldInput) {
          held.delete(key);
        }
        return result;
      },
    },
    release: async () => {
      const inputs = [...held.entries()];
      for (const [key, { target, frame }] of inputs) {
        const result = await proxy.send(target, { ...frame, id: sequence-- });
        if (result.error) { throw new Error(result.error.message); }
        held.delete(key);
      }
    },
  };
}
