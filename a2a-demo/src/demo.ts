import type { Server } from 'node:http';
import { createPeerServer, type PeerServer } from './peers/create-peer-server.js';
import { createServer } from './server.js';

const PEERS = [
  {
    name: 'Sarah',
    port: 3010,
    assistantId: 'sarah-assistant',
    config: {
      name: 'Sarah',
      responseText: 'Cortado, oat milk',
      strategy: 'standing_preference' as const,
      humanDelayMs: 0,
    },
  },
  {
    name: 'Jake',
    port: 3011,
    assistantId: 'jake-assistant',
    config: {
      name: 'Jake',
      responseText: 'Black drip, large',
      strategy: 'hitl_confirm' as const,
      humanDelayMs: 3000,
    },
  },
  {
    name: 'Maria',
    port: 3012,
    assistantId: 'maria-assistant',
    config: {
      name: 'Maria',
      responseText: 'Usually an Americano, unconfirmed',
      strategy: 'hitl_stale_infer' as const,
      humanDelayMs: 6000,
    },
  },
  {
    name: 'Priya',
    port: 3013,
    assistantId: 'priya-assistant',
    config: {
      name: 'Priya',
      responseText: "Priya's in a meeting, no response",
      strategy: 'hitl_unreachable' as const,
      humanDelayMs: 8000,
    },
  },
];

async function waitForServer(url: string, retries = 20, delayMs = 200): Promise<void> {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // Not ready yet
    }
    await Bun.sleep(delayMs);
  }
  throw new Error(`Server at ${url} did not become ready`);
}

async function main() {
  const peerServers: PeerServer[] = [];
  let mainServer: Server | undefined;

  function shutdown() {
    console.log('\nShutting down...');
    if (mainServer) mainServer.close();
    for (const ps of peerServers) ps.server.close();
    process.exit(0);
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Build UI
  console.log('Building UI...');
  const result = Bun.spawnSync(['bun', 'run', 'build:ui'], {
    cwd: import.meta.dir + '/..',
    stdout: 'inherit',
    stderr: 'inherit',
  });
  if (result.exitCode !== 0) {
    console.error('UI build failed');
    process.exit(1);
  }
  console.log('UI built successfully');

  // Start all peer servers in-process
  console.log('Starting peer servers...');
  for (const peer of PEERS) {
    const ps = createPeerServer(peer);
    peerServers.push(ps);
  }

  // Wait for all peers to be ready
  await Promise.all(
    PEERS.map((peer) => waitForServer(`http://localhost:${peer.port}/.well-known/agent-card.json`)),
  );
  console.log('All peers ready on ports 3010-3013');

  // Start main server
  const { server } = createServer();
  mainServer = server;

  await waitForServer(`http://localhost:${Number(process.env.PORT) || 3000}/.well-known/agent-card.json`);
  console.log(`\nDemo ready at http://localhost:${Number(process.env.PORT) || 3000}`);
}

main().catch((err) => {
  console.error('Demo failed to start:', err);
  process.exit(1);
});
