import { createPeerServer } from './create-peer-server.js';

const { server } = createPeerServer({
  name: 'Jake',
  port: 3011,
  assistantId: 'jake-assistant',
  config: {
    name: 'Jake',
    responseText: 'Black drip, large',
    strategy: 'hitl_confirm',
    humanDelayMs: 3000,
  },
});

server.on('listening', () => {
  console.log('[Jake] listening on port 3011');
});
