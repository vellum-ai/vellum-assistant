import { createPeerServer } from './create-peer-server.js';

const { server } = createPeerServer({
  name: 'Maria',
  port: 3012,
  assistantId: 'maria-assistant',
  config: {
    name: 'Maria',
    responseText: 'Usually an Americano, unconfirmed',
    strategy: 'hitl_stale_infer',
    humanDelayMs: 6000,
  },
});

server.on('listening', () => {
  console.log('[Maria] listening on port 3012');
});
