import type { CdpProxy, CdpRequestFrame, CdpTarget } from './cdp-proxy.js';

export function trackDesktopInput(proxy: CdpProxy): { proxy: CdpProxy; release: () => Promise<void> } {
  const held = new Map<string, { target: CdpTarget; frame: CdpRequestFrame }>();
  let sequence = -1;
  proxy.onDetach((target) => {
    for (const [key, input] of held) {
      if ((target.tabId !== undefined && input.target.tabId === target.tabId) ||
          (target.targetId !== undefined && input.target.targetId === target.targetId)) {
        held.delete(key);
      }
    }
  });
  return {
    proxy: {
      ...proxy,
      send: async (target, frame) => {
        const params = frame.params ?? {};
        const key = JSON.stringify([target, frame.method, params.key ?? params.button]);
        const previous = held.get(key);
        const pressed = params.type === 'keyDown' || params.type === 'rawKeyDown' || params.type === 'mousePressed';
        if (pressed) {
          held.set(key, { target, frame: { ...frame, params: { ...params, type: frame.method === 'Input.dispatchKeyEvent' ? 'keyUp' : 'mouseReleased' } } });
        }
        const heldInput = held.get(key);
        const result = await proxy.send(target, frame);
        if (result.error && pressed && held.get(key) === heldInput) {
          if (previous) {
            held.set(key, previous);
          } else {
            held.delete(key);
          }
        }
        if (!result.error && (params.type === 'keyUp' || params.type === 'mouseReleased') && held.get(key) === heldInput) {
          held.delete(key);
        }
        return result;
      },
    },
    release: async () => {
      const inputs = [...held.entries()];
      for (const [key, input] of inputs) {
        if (held.get(key) !== input) { continue; }
        const { target, frame } = input;
        const result = await proxy.send(target, { ...frame, id: sequence-- });
        if (held.get(key) === input) {
          if (result.error) { throw new Error(result.error.message); }
          held.delete(key);
        }
      }
    },
  };
}
