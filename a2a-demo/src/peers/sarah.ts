import { createPeerServer } from './create-peer-server.js';

const { server } = createPeerServer({
  name: 'Sarah',
  port: 3010,
  assistantId: 'sarah-assistant',
  config: {
    name: 'Sarah',
    responseText: 'Cortado, oat milk',
    strategy: 'standing_preference',
    humanDelayMs: 0,
  },
});

server.on('listening', () => {
  console.log('[Sarah] listening on port 3010');
});
