import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

interface PeerDef {
  label: string;
  script: string;
  port: number;
}

const peers: PeerDef[] = [
  { label: 'Sarah', script: 'sarah.ts', port: 3010 },
  { label: 'Jake', script: 'jake.ts', port: 3011 },
  { label: 'Maria', script: 'maria.ts', port: 3012 },
  { label: 'Priya', script: 'priya.ts', port: 3013 },
];

const children: Array<ReturnType<typeof Bun.spawn>> = [];

for (const peer of peers) {
  const scriptPath = resolve(__dirname, peer.script);

  const child = Bun.spawn(['bun', 'run', scriptPath], {
    stdout: 'pipe',
    stderr: 'pipe',
  });

  children.push(child);

  // Pipe stdout with prefix
  (async () => {
    if (!child.stdout) return;
    const reader = child.stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        console.log(`[${peer.label}] ${line}`);
      }
    }
    if (buffer) {
      console.log(`[${peer.label}] ${buffer}`);
    }
  })();

  // Pipe stderr with prefix
  (async () => {
    if (!child.stderr) return;
    const reader = child.stderr.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        console.error(`[${peer.label}] ${line}`);
      }
    }
    if (buffer) {
      console.error(`[${peer.label}] ${buffer}`);
    }
  })();
}

console.log('All peers started on ports 3010-3013');

function shutdown() {
  console.log('\nShutting down peers...');
  for (const child of children) {
    child.kill();
  }
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Keep the process alive by awaiting all children
await Promise.all(children.map((child) => child.exited));
