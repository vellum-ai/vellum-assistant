import { createPeerServer } from './create-peer-server.js';

const { server } = createPeerServer({
  name: 'Priya',
  port: 3013,
  assistantId: 'priya-assistant',
  config: {
    name: 'Priya',
    responseText: "Priya's in a meeting, no response",
    strategy: 'hitl_unreachable',
    humanDelayMs: 8000,
  },
});

server.on('listening', () => {
  console.log('[Priya] listening on port 3013');
});
