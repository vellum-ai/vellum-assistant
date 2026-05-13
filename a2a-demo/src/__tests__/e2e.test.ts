import { describe, test, expect, afterAll } from 'bun:test';
import type { Server } from 'node:http';
import { createPeerServer, type PeerServer } from '../peers/create-peer-server.js';
import { createServer } from '../server.js';
import type { Connection } from '../types.js';

const BASE_PORT = 3100;
const PEER_PORTS = { sarah: 3110, jake: 3111, maria: 3112, priya: 3113 };

interface SSEEvent {
  type: string;
  data: Record<string, unknown>;
}

function parseSSE(text: string): SSEEvent[] {
  const events: SSEEvent[] = [];
  const blocks = text.split('\n\n').filter(Boolean);
  for (const block of blocks) {
    const lines = block.split('\n');
    let type = '';
    let data = '';
    for (const line of lines) {
      if (line.startsWith('event: ')) type = line.slice(7);
      else if (line.startsWith('data: ')) data = line.slice(6);
    }
    if (type && data) {
      try {
        events.push({ type, data: JSON.parse(data) });
      } catch {
        // skip malformed
      }
    }
  }
  return events;
}

const testConnections: Connection[] = [
  {
    id: 'test_conn_sarah',
    owner_assistant_id: 'test-assistant',
    peer_assistant_id: 'peer-sarah',
    peer_agent_card_url: `http://localhost:${PEER_PORTS.sarah}/.well-known/agent-card.json`,
    peer_base_url: `http://localhost:${PEER_PORTS.sarah}`,
    declared_relationship: 'colleague',
    scopes: ['coffee_order'],
    created_at: '2026-01-01T00:00:00Z',
  },
  {
    id: 'test_conn_jake',
    owner_assistant_id: 'test-assistant',
    peer_assistant_id: 'peer-jake',
    peer_agent_card_url: `http://localhost:${PEER_PORTS.jake}/.well-known/agent-card.json`,
    peer_base_url: `http://localhost:${PEER_PORTS.jake}`,
    declared_relationship: 'colleague',
    scopes: ['coffee_order'],
    created_at: '2026-01-01T00:00:00Z',
  },
  {
    id: 'test_conn_maria',
    owner_assistant_id: 'test-assistant',
    peer_assistant_id: 'peer-maria',
    peer_agent_card_url: `http://localhost:${PEER_PORTS.maria}/.well-known/agent-card.json`,
    peer_base_url: `http://localhost:${PEER_PORTS.maria}`,
    declared_relationship: 'colleague',
    scopes: ['coffee_order'],
    created_at: '2026-01-01T00:00:00Z',
  },
  {
    id: 'test_conn_priya',
    owner_assistant_id: 'test-assistant',
    peer_assistant_id: 'peer-priya',
    peer_agent_card_url: `http://localhost:${PEER_PORTS.priya}/.well-known/agent-card.json`,
    peer_base_url: `http://localhost:${PEER_PORTS.priya}`,
    declared_relationship: 'colleague',
    scopes: ['coffee_order'],
    created_at: '2026-01-01T00:00:00Z',
  },
];

// --- Server setup ---

const peerServers: PeerServer[] = [];
let mainServer: Server;

const sarahServer = createPeerServer({
  name: 'Sarah',
  port: PEER_PORTS.sarah,
  assistantId: 'sarah-assistant',
  config: { name: 'Sarah', responseText: 'Cortado, oat milk', strategy: 'standing_preference', humanDelayMs: 50 },
});
peerServers.push(sarahServer);

const jakeServer = createPeerServer({
  name: 'Jake',
  port: PEER_PORTS.jake,
  assistantId: 'jake-assistant',
  config: { name: 'Jake', responseText: 'Black drip, large', strategy: 'hitl_confirm', humanDelayMs: 200 },
});
peerServers.push(jakeServer);

const mariaServer = createPeerServer({
  name: 'Maria',
  port: PEER_PORTS.maria,
  assistantId: 'maria-assistant',
  config: { name: 'Maria', responseText: 'Usually an Americano, unconfirmed', strategy: 'hitl_stale_infer', humanDelayMs: 500 },
});
peerServers.push(mariaServer);

const priyaServer = createPeerServer({
  name: 'Priya',
  port: PEER_PORTS.priya,
  assistantId: 'priya-assistant',
  config: { name: 'Priya', responseText: "Priya's in a meeting, no response", strategy: 'hitl_unreachable', humanDelayMs: 700 },
});
peerServers.push(priyaServer);

const { server } = createServer({
  port: BASE_PORT,
  connections: testConnections,
  assistantName: 'Test Assistant',
  assistantId: 'test-assistant',
});
mainServer = server;

afterAll(() => {
  mainServer.close();
  for (const ps of peerServers) ps.server.close();
});

// Helper to wait for a server to be ready
async function waitReady(port: number, retries = 30): Promise<void> {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(`http://localhost:${port}/.well-known/agent-card.json`);
      if (res.ok) return;
    } catch {
      // not ready
    }
    await Bun.sleep(100);
  }
  throw new Error(`Server on port ${port} did not become ready`);
}

describe('e2e coffee run', () => {
  test(
    'full scenario exercises all 4 response strategies and HITL states',
    async () => {
      // Wait for all servers to be ready
      await Promise.all([
        waitReady(BASE_PORT),
        waitReady(PEER_PORTS.sarah),
        waitReady(PEER_PORTS.jake),
        waitReady(PEER_PORTS.maria),
        waitReady(PEER_PORTS.priya),
      ]);

      // Subscribe to SSE BEFORE triggering the coffee run
      const sseResponse = await fetch(`http://localhost:${BASE_PORT}/events`);
      expect(sseResponse.ok).toBe(true);
      expect(sseResponse.headers.get('content-type')).toBe('text/event-stream');

      const reader = sseResponse.body!.getReader();
      const decoder = new TextDecoder();
      let sseBuffer = '';
      const allEvents: SSEEvent[] = [];

      // Read the initial :ok comment
      {
        const { value } = await reader.read();
        if (value) sseBuffer += decoder.decode(value, { stream: true });
      }

      // Trigger coffee run
      const runRes = await fetch(`http://localhost:${BASE_PORT}/run/coffee`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deadlineSeconds: 15 }),
      });
      expect(runRes.status).toBe(202);

      // Collect SSE events until run_complete
      const deadline = Date.now() + 25_000;
      let gotRunComplete = false;

      while (!gotRunComplete && Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) {
          sseBuffer += decoder.decode(value, { stream: true });
        }
        const newEvents = parseSSE(sseBuffer);
        // Only add events we haven't seen yet
        if (newEvents.length > allEvents.length) {
          for (let i = allEvents.length; i < newEvents.length; i++) {
            allEvents.push(newEvents[i]);
            if (newEvents[i].type === 'run_complete') {
              gotRunComplete = true;
            }
          }
        }
      }

      // Cancel the reader to close the connection
      await reader.cancel();

      expect(gotRunComplete).toBe(true);

      // --- Assert all 4 peers reach task_completed ---
      const completedEvents = allEvents.filter((e) => e.type === 'task_completed');
      const completedPeers = completedEvents.map((e) => e.data.peer as string).sort();
      expect(completedPeers).toEqual(['peer-jake', 'peer-maria', 'peer-priya', 'peer-sarah']);

      // --- Assert response_basis values ---
      const basisByPeer = Object.fromEntries(
        completedEvents.map((e) => [e.data.peer, e.data.responseBasis]),
      );
      expect(basisByPeer['peer-sarah']).toBe('standing_preference');
      expect(basisByPeer['peer-jake']).toBe('confirmed');
      expect(basisByPeer['peer-maria']).toBe('inferred');
      expect(basisByPeer['peer-priya']).toBe('unreachable');

      // --- Assert HITL states ---
      const hitlEvents = allEvents.filter((e) => e.type === 'hitl_update');
      const hitlPeers = new Set(hitlEvents.map((e) => e.data.peer as string));
      // jake, maria, priya should have awaiting_human_input
      expect(hitlPeers.has('peer-jake')).toBe(true);
      expect(hitlPeers.has('peer-maria')).toBe(true);
      expect(hitlPeers.has('peer-priya')).toBe(true);

      // maria should also have awaiting_human_input_stale
      const mariaHitlStates = hitlEvents
        .filter((e) => e.data.peer === 'peer-maria')
        .map((e) => e.data.hitlState as string | null);
      expect(mariaHitlStates).toContain('awaiting_human_input');
      expect(mariaHitlStates).toContain('awaiting_human_input_stale');

      // --- Assert protocol_event events include raw SDK data ---
      const protocolEvents = allEvents.filter((e) => e.type === 'protocol_event');
      expect(protocolEvents.length).toBeGreaterThan(0);

      // Task IDs should be present in protocol events
      const protocolWithTaskId = protocolEvents.filter((e) => e.data.taskId != null);
      expect(protocolWithTaskId.length).toBeGreaterThan(0);

      // Extension payloads should be present (events carry full prettified event data)
      const protocolWithEvent = protocolEvents.filter((e) => e.data.sdkEvent != null);
      expect(protocolWithEvent.length).toBeGreaterThan(0);

      // --- Assert task_sent events include method: 'message/stream' ---
      const taskSentEvents = allEvents.filter((e) => e.type === 'task_sent');
      expect(taskSentEvents.length).toBe(4);
      for (const ev of taskSentEvents) {
        expect(ev.data.method).toBe('message/stream');
      }

      // --- Assert agent-card discovery happened ---
      // Each peer's x-vellum-social-v1 was checked — verified by the fact that
      // no task_error events with "does not support x-vellum-social-v1" appeared
      // and all 4 peers completed successfully
      const errorEvents = allEvents.filter(
        (e) => e.type === 'task_error' && String(e.data.error).includes('x-vellum-social-v1'),
      );
      expect(errorEvents.length).toBe(0);
    },
    30_000,
  );
});
