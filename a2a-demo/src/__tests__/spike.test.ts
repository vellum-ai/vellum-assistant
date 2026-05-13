import { describe, test, expect, afterAll } from 'bun:test';
import type { Server } from 'http';
import type { Message, TaskArtifactUpdateEvent, TaskStatusUpdateEvent } from '@a2a-js/sdk';
import { ClientFactory, ClientFactoryOptions } from '@a2a-js/sdk/client';
import { createSpikeServer } from '../spike.js';

// Use a random high port to avoid collisions
const PORT = 30_000 + Math.floor(Math.random() * 10_000);

let server: Server;

afterAll(() => {
  server?.close();
});

describe('SDK spike roundtrip', () => {
  test('server/client lifecycle completes with echo artifact', async () => {
    server = createSpikeServer(PORT);

    await new Promise<void>((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
      if (server.listening) resolve();
    });

    // Create client via ClientFactory
    const factory = new ClientFactory(
      ClientFactoryOptions.createFrom(ClientFactoryOptions.default, {}),
    );
    const client = await factory.createFromUrl(`http://localhost:${PORT}`);

    // Build message
    const message: Message = {
      kind: 'message',
      messageId: crypto.randomUUID(),
      role: 'user',
      parts: [{ kind: 'text', text: 'hello from spike test' }],
    };

    // Collect stream events
    const events: Array<Message | import('@a2a-js/sdk').Task | TaskStatusUpdateEvent | TaskArtifactUpdateEvent> = [];
    for await (const event of client.sendMessageStream({ message })) {
      events.push(event);
    }

    // Verify we received events
    expect(events.length).toBeGreaterThan(0);

    // Find the artifact-update event
    const artifactEvent = events.find((e) => e.kind === 'artifact-update') as TaskArtifactUpdateEvent | undefined;
    expect(artifactEvent).toBeDefined();
    expect(artifactEvent!.artifact.parts).toHaveLength(1);
    expect(artifactEvent!.artifact.parts[0].kind).toBe('text');
    expect((artifactEvent!.artifact.parts[0] as { kind: 'text'; text: string }).text).toBe(
      'echo: hello from spike test',
    );

    // Find the completed status event
    const statusEvent = events.find(
      (e) => e.kind === 'status-update' && (e as TaskStatusUpdateEvent).status.state === 'completed',
    ) as TaskStatusUpdateEvent | undefined;
    expect(statusEvent).toBeDefined();
    expect(statusEvent!.final).toBe(true);
  });
});
